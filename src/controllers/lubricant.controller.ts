import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import lubricantModel, { PRODUCT_CATEGORIES } from "../models/lubricant.model";
import StorePricingSettings from "../models/storePricingSettings.model";
import { toNaira, repriceSaleUnits, defaultModeFor } from "../utils/storePricing";
import lubricantSaleModels from "../models/lubricant-sale.models";
import LubricantTransaction from "../models/lubricant-transaction.model";
import mongoose from "mongoose";
import Activity from "../models/activity.model";
import { actorFrom } from "../utils/actor";
import { notifyStation } from "../utils/notifyHelpers";
import { emitToStation } from "../services/socket.service";
import { ensureOpeningBatch, consumeFIFO } from "../services/stockBatch.service";

/**
 * The station's pricing defaults, created on first read.
 *
 * Same pattern as the loyalty settings: a station that has never opened the
 * screen still gets sensible numbers rather than zeros, and a 0% default would
 * quietly sell everything at cost.
 */
const getOrCreatePricingSettings = async (stationId: string) => {
  const existing = await StorePricingSettings.findOne({ fillingStation: stationId }).lean();
  if (existing) return existing;
  await StorePricingSettings.create({ fillingStation: stationId });
  return await StorePricingSettings.findOne({ fillingStation: stationId }).lean();
};

/** GET /api/lubricant/pricing-settings — read by the add-product form. */
export const getPricingSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }
    const settings = await getOrCreatePricingSettings(String(fillingStation));
    return res.status(200).json({ data: settings });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/** PATCH /api/lubricant/pricing-settings — manager only. */
export const updatePricingSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { categoryMarkups, unitMarkups } = req.body;
    const update: any = {};

    if (categoryMarkups && typeof categoryMarkups === "object") {
      const clean: Record<string, number> = {};
      for (const [category, value] of Object.entries(categoryMarkups)) {
        if (!PRODUCT_CATEGORIES.includes(category as any)) continue;
        const pct = Number(value);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
          return res.status(400).json({ error: `${category} markup must be between 0 and 100` });
        }
        clean[category] = pct;
      }
      update.categoryMarkups = clean;
    }

    if (Array.isArray(unitMarkups)) {
      const clean: any[] = [];
      for (const u of unitMarkups) {
        const name = String(u?.name || "").trim();
        const pct = Number(u?.sellingPercentage);
        if (!name) continue;
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
          return res.status(400).json({ error: `"${name}" markup must be between 0 and 100` });
        }
        if (clean.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
          return res.status(400).json({ error: `"${name}" is listed twice` });
        }
        clean.push({ name, sellingPercentage: pct });
      }
      update.unitMarkups = clean;
    }

    const settings = await StorePricingSettings.findOneAndUpdate(
      { fillingStation },
      { $set: update, $setOnInsert: { fillingStation } },
      { new: true, upsert: true, runValidators: true }
    ).lean();

    return res.status(200).json({
      // Said plainly, because the alternative — silently re-pricing the whole
      // shelf — is what a user might fear this button does.
      message: "Pricing defaults saved. Products already registered keep their own percentage.",
      data: settings,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * Tell the manager a cashier has added something that needs pricing.
 *
 * The product is in the system but cannot be sold yet, so this is not a courtesy
 * note — it is the step that unblocks a sale someone is waiting on. Sent as an
 * alert for that reason. Silent for a manager's own registration: they priced it
 * as they created it.
 */
const notifyProductRegistered = (
  req: AuthenticatedRequest,
  stationId: any,
  product: any
): void => {
  if (req.user?.role !== "cashier" || !product) return;

  const who = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(" ") || "A cashier";
  notifyStation(String(stationId), {
    type: "alert",
    category: "product_registered",
    title: "New product needs a price",
    body: `${who} registered "${product.productName}" (${product.category || "lubricant"}) at the till. It cannot be sold until you set its cost and price.`,
    severity: "warning",
    targetRole: "manager",
  });
};

/**
 * PATCH /api/lubricant/:id/pricing — manager sets or corrects what a product costs.
 *
 * The other half of the cashier's till registration: they said what the item is,
 * this says what it is worth. Also the ordinary "change a price" action, so a
 * manager does not have to delete and re-create a product to fix one number.
 *
 * Re-prices every bigger unit off the new figures, because a carton priced
 * against last month's cost is the quiet loss this whole ladder exists to avoid.
 */
export const updateLubricantPricing = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { unitCost, sellingPercentage, saleUnits, reOrderLevel } = req.body;

    const product = await lubricantModel.findOne({ _id: req.params.id, fillingStation });
    if (!product) return res.status(404).json({ error: "Product not found" });

    const cost = Number(unitCost ?? product.unitCost) || 0;
    const pct = Number(sellingPercentage ?? product.sellingPercentage) || 0;

    if (!Number.isFinite(cost) || cost < 0) {
      return res.status(400).json({ error: "Cost price must be a positive number" });
    }
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return res.status(400).json({ error: "Profit must be a percentage between 0 and 100" });
    }

    const price = toNaira(cost * (1 + pct / 100));

    product.unitCost = cost;
    product.sellingPercentage = pct;
    product.unitPrice = price;
    if (reOrderLevel !== undefined) product.reOrderLevel = Number(reOrderLevel) || 0;

    // Units come from the request when the manager edited them, otherwise the
    // product's own are re-priced against the new cost.
    const incoming = Array.isArray(saleUnits) ? saleUnits : (product.saleUnits || []);
    product.saleUnits = repriceSaleUnits(incoming as any, cost, price) as any;

    // It has a price now, so the till may sell it.
    product.pendingPricing = false;
    await product.save();

    return res.status(200).json({
      message: `${product.productName} priced at ₦${price.toLocaleString()}.`,
      lubricant: product,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const addLubricant = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const {
      barcode,
      productName,
      productType,
      category,
      brand,
      qtyInStock,
      reOrderLevel,
      unitCost,
      sellingPercentage, // Changed from sellingPrice to sellingPercentage
      baseUnit,
      saleUnits,
    } = req.body;

    // Category decides which revenue and cost accounts a sale posts to, so an
    // unrecognised value must never be stored — it would silently misclassify
    // every future sale of that product. Anything unknown falls back to the
    // historical behaviour rather than inventing a new bucket.
    const ALLOWED_CATEGORIES = ["lubricant", "drinks", "snacks", "other"];
    const cat = ALLOWED_CATEGORIES.includes(String(category || "").toLowerCase())
      ? String(category).toLowerCase()
      : "lubricant";

    // Required fields now
    if (!productName || !brand) {
      return res.status(400).json({
        error: "Required fields missing. Provide productName and brand.",
      });
    }

    // Numbers
    const qty = Number(qtyInStock ?? 0);
    const reorder = Number(reOrderLevel ?? 0);
    const unitCostNum = Number(unitCost ?? 0);
    const percentage = Number(sellingPercentage ?? 0);

    // Validation
    if (!Number.isFinite(qty) || qty < 0)
      return res.status(400).json({ error: "qtyInStock must be non-negative" });

    if (!Number.isFinite(reorder) || reorder < 0)
      return res.status(400).json({ error: "reOrderLevel must be non-negative" });

    if (!Number.isFinite(unitCostNum) || unitCostNum < 0)
      return res.status(400).json({ error: "unitCost must be non-negative" });

    // sellingPercentage is PERCENTAGE. Not asked of a cashier — they never see
    // the field — so only checked when it could have been set.
    if (req.user?.role !== "cashier" && (!Number.isFinite(percentage) || percentage < 0 || percentage > 100)) {
      return res.status(400).json({
        error: "sellingPercentage must be a percentage between 0 and 100",
      });
    }

    /**
     * A cashier registers WHAT the item is; a manager decides what it costs.
     *
     * The till button exists so a customer holding an unknown item is not turned
     * away — but a price set by whoever is on the counter is how a shop sells at
     * a loss for weeks. So the identifying details are kept, every money field is
     * discarded, and the product is parked as `pendingPricing` until a manager
     * prices it. The POS refuses to sell it in the meantime and says why.
     */
    const isCashier = req.user?.role === "cashier";

    // Whole naira: kobo cannot be tendered at a counter.
    const unitPriceNum = isCashier ? 0 : toNaira(unitCostNum * (1 + percentage / 100));

    /**
     * Bigger selling units — a pack of 12, a carton of 24.
     *
     * Priced the same way the single is, one level up: the unit's cost is the
     * piece cost times the factor, and its own markup is applied to that. A
     * lower markup on a bigger unit is what makes a pack cheaper per piece, and
     * because the price is derived it can never be set below cost by accident,
     * and every unit re-prices itself when the cost price changes.
     *
     *   ₦300 piece, 20%          → ₦360
     *   pack of 12, 15% markup   → 300 × 12 × 1.15 = ₦4,140  (₦345 a piece)
     *
     * `factor` is validated hard because it is the number that decides how much
     * stock a sale removes: a typo of 120 for 12 empties a shelf that still has
     * bottles on it, and nothing downstream would question it.
     *
     * Names are compared case-insensitively and must not collide with the base
     * unit — two ways to say "piece" would make the till ambiguous about what it
     * just sold.
     */
    const base = String(baseUnit || "piece").trim() || "piece";
    const cleanUnits: any[] = [];
    for (const u of Array.isArray(saleUnits) ? saleUnits : []) {
      const name = String(u?.name || "").trim();
      const factor = Number(u?.factor);

      if (!name) return res.status(400).json({ error: "Every sale unit needs a name (e.g. Pack, Carton)" });
      if (!Number.isInteger(factor) || factor < 2) {
        return res.status(400).json({
          error: `"${name}" must contain at least 2 ${base}s — a unit of one is just a ${base}.`,
        });
      }
      if (name.toLowerCase() === base.toLowerCase()) {
        return res.status(400).json({ error: `"${name}" is already the base unit of this product` });
      }
      if (cleanUnits.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
        return res.status(400).json({ error: `"${name}" is listed twice` });
      }

      // Defaults to the product's own markup: a station that has not thought
      // about pack pricing yet gets the same margin it makes on singles, which
      // is the honest starting point.
      const unitPct = u?.sellingPercentage === undefined || u?.sellingPercentage === null || u?.sellingPercentage === ""
        ? percentage
        : Number(u.sellingPercentage);

      if (!Number.isFinite(unitPct) || unitPct < 0 || unitPct > 100) {
        return res.status(400).json({
          error: `"${name}" markup must be a percentage between 0 and 100`,
        });
      }

      cleanUnits.push({
        name,
        factor,
        // How this unit reaches the shelf decides how it is priced — bought from
        // the supplier (carton) or made by opening one (pack). See storePricing.
        pricingMode: u?.pricingMode || defaultModeFor(name),
        sellingPercentage: unitPct,
        unitCost: Number(u?.unitCost) || 0,
        discountPercentage: Number(u?.discountPercentage) || 0,
        price: Number(u?.price) || 0,
        barcode: String(u?.barcode || "").trim() || undefined,
      });
    }

    // One place computes every price, so registration and goods receipt can
    // never disagree about what a carton costs. A cashier's product has no
    // prices at all, so there is nothing to compute.
    const pricedUnits = isCashier ? [] : repriceSaleUnits(cleanUnits, unitCostNum, unitPriceNum);

    // ðŸ”¥ If barcode is provided â†’ upsert/update
    if (barcode) {
      const query = {
        fillingStation: new Types.ObjectId(fillingStation),
        barcode: barcode.trim(),
      };

      /**
       * A cashier may register something new; they may not restock.
       *
       * This endpoint upserts — an existing barcode gets `$inc: qtyInStock` and
       * fresh cost/price. That is a manager's decision (it moves stock value and
       * the shelf price), and it is the one thing a till operator must not be
       * able to do by re-registering a product that already exists. Registering
       * a genuinely unknown item, which is what the POS button is for, stays
       * open to them.
       */
      if (req.user?.role === "cashier") {
        const existing = await lubricantModel.findOne(query).select("productName").lean();
        if (existing) {
          return res.status(409).json({
            error: `${(existing as any).productName} is already in the system. Ask a manager to restock it or change its price.`,
          });
        }
      }

      const update = {
        $inc: { qtyInStock: qty },
        $set: {
          productName: productName.trim(),
          productType: productType?.trim() ?? "",
          category: cat,
          brand: brand.trim(),
          reOrderLevel: reorder,
          unitCost: unitCostNum,
          sellingPercentage: percentage,
          unitPrice: unitPriceNum,
          baseUnit: base,
          saleUnits: pricedUnits,
        },
        $setOnInsert: {
          fillingStation: new Types.ObjectId(fillingStation),
          barcode: barcode.trim(),
          // Only ever true on insert: a cashier cannot reach the update branch
          // (the guard above stops them), so this can never un-price a product
          // a manager has already priced.
          pendingPricing: isCashier,
          registeredBy: req.user?.id,
        },
      };

      const options = {
        new: true,
        upsert: true,
        runValidators: true,
      };

      const result = await lubricantModel
        .findOneAndUpdate(query, update, options)
        .lean()
        .exec();

      notifyProductRegistered(req, fillingStation, result);

      return res.status(200).json({
        message: "Lubricant added/updated successfully",
        lubricant: result,
      });
    }

    // ðŸ”¥ If NO barcode â†’ create new product only
    const newLubricant = await lubricantModel.create({
      fillingStation,
      productName,
      productType,
      category: cat,
      brand,
      qtyInStock: qty,
      reOrderLevel: reorder,
      unitCost: unitCostNum,
      sellingPercentage: percentage,
      unitPrice: unitPriceNum,
      baseUnit: base,
      saleUnits: pricedUnits,
      pendingPricing: isCashier,
      registeredBy: req.user?.id,
    });

    notifyProductRegistered(req, fillingStation, newLubricant);

    return res.status(201).json({
      message: "Lubricant created successfully",
      lubricant: newLubricant,
    });

  } catch (err: any) {
    console.error("Error in addLubricant:", err);

    if (err?.code === 11000) {
      return res.status(409).json({ error: "Duplicate barcode detected" });
    }

    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const getAllLubricants = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;

    // ðŸ”’ Authorization check
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    // ðŸ§­ Find all lubricants for this filling station
    const lubricants = await lubricantModel.find({ fillingStation })
      .sort({ createdAt: -1 })
      .lean();

    // ðŸ§® Calculate low-stock count
    const lowStockCount = lubricants.filter((lube) => {
      const currentQty = lube.qtyInStock;
      return !isNaN(currentQty) && currentQty < lube.reOrderLevel;
    }).length;

    // âœ… Respond
    return res.status(200).json({
      message: "Lubricants retrieved successfully",
      totalLubricants: lubricants.length,
      lowStockCount,
      data: lubricants,
    });
  } catch (error: any) {
    console.error("Error fetching lubricants:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};

export const getLubricantByBarcode = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { barcode } = req.body;

    // ðŸ”’ Authorization check
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    // ðŸ” Validate barcode
    if (!barcode) {
      return res.status(400).json({ error: "Barcode is required" });
    }

    // ðŸ§­ Find lubricant belonging to this station with the given barcode.
    // A carton carries its own code printed on the case, so a scan can legitimately
    // match either the product's barcode or one of its units'. Checking only the
    // former answered "not found" for a barcode the station had registered.
    const lubricant = await lubricantModel.findOne({
      fillingStation,
      $or: [
        { barcode: barcode.trim() },
        { "saleUnits.barcode": barcode.trim() },
      ],
    }).lean();

    // Not stocked here. `code` lets the till distinguish this from an
    // out-of-stock product and offer to register it, instead of showing one
    // vague "not found" for two completely different situations.
    if (!lubricant) {
      return res.status(404).json({
        code: "NOT_FOUND",
        error: `No product with barcode "${barcode.trim()}" at this station.`,
        barcode: barcode.trim(),
      });
    }

    // Known product, nothing on the shelf. The name and count go back with the
    // error — "Out of stock" alone leaves the cashier looking it up by hand.
    const currentQty = Number(lubricant.qtyInStock);
    if (!Number.isFinite(currentQty) || currentQty <= 0) {
      return res.status(409).json({
        code: "OUT_OF_STOCK",
        error: `${lubricant.productName} (${barcode.trim()}) has 0 in stock — restock before selling.`,
        barcode: barcode.trim(),
        productName: lubricant.productName,
        qtyInStock: 0,
      });
    }

    // âœ… Success
    return res.status(200).json({
      message: "Lubricant retrieved successfully",
      data: lubricant,
    });
  } catch (error: any) {
    console.error("Error fetching lubricant by barcode:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};

// export const addLubricantSale = async (req: AuthenticatedRequest, res: Response) => {
//   try {
//     const staffId = req.user?.id;
//     const fillingStation = req.user?.station;
//     const { lubricantId, paymentMethod, priceSold, qtySold } = req.body;

//     // ðŸ”’ Check authorization
//     if (!fillingStation) {
//       return res.status(403).json({ error: "You are not authorized to perform this action" });
//     }

//     // âœ… Validate input
//     if (!lubricantId || !paymentMethod || !priceSold || !qtySold) {
//       return res.status(400).json({ error: "Missing required fields" });
//     }

//     // ðŸ” Find the lubricant in this station
//     const lubricant = await lubricantModel.findOne({
//       _id: new mongoose.Types.ObjectId(lubricantId),
//       fillingStation: new mongoose.Types.ObjectId(fillingStation),
//     });

//     if (!lubricant) {
//       return res.status(404).json({ error: "Lubricant not found in this filling station" });
//     }

//     // ðŸ§® Check stock level
//     const currentQty = lubricant.qtyInStock;
//     if (isNaN(currentQty) || currentQty <= 0) {
//       return res.status(400).json({ error: "Out of stock" });
//     }

//     if (qtySold > currentQty) {
//       return res.status(400).json({ error: `Cannot sell ${qtySold} units. Only ${currentQty} available.` });
//     }

//     // ðŸ’° Deduct sold quantity and save
//     const newQty = currentQty - qtySold;
//     lubricant.qtyInStock = newQty;
//     await lubricant.save();

//     // ðŸ§¾ Record the sale
//     const sale = await lubricantSaleModels.create({
//       fillingStation,
//       lubricant: lubricant._id,
//       staff: staffId,
//       paymentMethod,
//       priceSold,
//       qtySold,
//     });

//     return res.status(201).json({
//       message: "Lubricant sale recorded successfully",
//       data: sale,
//       remainingStock: newQty,
//     });
//   } catch (error: any) {
//     console.error("Error adding lubricant sale:", error);
//     return res.status(500).json({
//       message: "Server error",
//       error: error.message,
//     });
//   }
// };

export const addLubricantSale = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const staffId = req.user?.id;
    const fillingStation = req.user?.station;

    const { 
      lubricantId, 
      paymentMethod, 
      priceSold, 
      qtySold,
      paymentBreakdown // â­ NEW FIELD
    } = req.body;

    // ðŸ”’ Authorization
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    // âœ… Validate basic fields
    if (!lubricantId || !paymentMethod || !priceSold || !qtySold) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // â­ If payment is mixed â†’ validate breakdown
    if (paymentMethod === "mixed") {
      if (!paymentBreakdown) {
        return res.status(400).json({
          error: "Payment breakdown is required for mixed payments"
        });
      }

      const { cash = 0, transfer = 0, POS = 0 } = paymentBreakdown;

      const sum = cash + transfer + POS;

      if (sum !== priceSold) {
        return res.status(400).json({
          error: `Payment breakdown total (${sum}) must equal priceSold (${priceSold})`
        });
      }
    }

    // ðŸ” Verify lubricant belongs to station
    const lubricant = await lubricantModel.findOne({
      _id: new mongoose.Types.ObjectId(lubricantId),
      fillingStation: new mongoose.Types.ObjectId(fillingStation),
    });

    if (!lubricant) {
      return res.status(404).json({ error: "Lubricant not found in this filling station" });
    }

    // ðŸ§® Check stock
    const currentQty = lubricant.qtyInStock;

    if (currentQty <= 0) {
      return res.status(400).json({ error: "Out of stock" });
    }

    if (qtySold > currentQty) {
      return res.status(400).json({
        error: `Cannot sell ${qtySold} units. Only ${currentQty} available.`,
      });
    }

    // ðŸ§® Deduct sold quantity
    const newQty = currentQty - qtySold;
    lubricant.qtyInStock = newQty;
    await lubricant.save();

    // ðŸ§¾ Create the sale record
    const sale = await lubricantSaleModels.create({
      fillingStation,
      lubricant: lubricant._id,
      staff: staffId,
      paymentMethod,
      priceSold,
      qtySold,
      ...(paymentMethod === "mixed" && { paymentBreakdown }), // â­ Only add breakdown if mixed
    });

    // Log sale activity (fire-and-forget)
    Activity.create({
      ...actorFrom(req.user),
      fillingStation,
      type: "sale",
      title: `Sale completed - ${lubricant.productName}`,
      description: `${lubricant.productName} â€“ ${qtySold} units sold`,
      timestamp: new Date(),
      severity: null,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    }).catch((err) => console.error("Activity log error (addLubricantSale):", err));

    return res.status(201).json({
      message: "Lubricant sale recorded successfully",
      data: sale,
      remainingStock: newQty,
    });

  } catch (error: any) {
    console.error("Error adding lubricant sale:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};


export const getAllLubricantSales = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    // Build pipeline
    const pipeline: any[] = [
      {
        $match: {
          fillingStation: new Types.ObjectId(fillingStation),
        },
      },
      // Join staff
      {
        $lookup: {
          from: "staffs",
          localField: "staff",
          foreignField: "_id",
          as: "staff",
        },
      },
      { $unwind: { path: "$staff", preserveNullAndEmptyArrays: true } },

      // Join lubricant
      {
        $lookup: {
          from: "lubricants",
          localField: "lubricant",
          foreignField: "_id",
          as: "lubricant",
        },
      },
      { $unwind: { path: "$lubricant", preserveNullAndEmptyArrays: true } },

      // Project required fields and compute amountSold
      {
        $project: {
          _id: 0,
          date: "$createdAt",
          staffName: {
            $cond: [
              { $and: [{ $ifNull: ["$staff.firstName", false] }, { $ifNull: ["$staff.lastName", false] }] },
              { $concat: ["$staff.firstName", " ", "$staff.lastName"] },
              { $ifNull: ["$staff.firstName", { $ifNull: ["$staff.email", "Unknown Staff"] }] },
            ],
          },
          txnId: 1,
          barcode: "$lubricant.barcode",
          productName: "$lubricant.productName",
          qtySold: 1,
          amountSold: { $multiply: ["$qtySold", "$priceSold"] },
          paymentMethod: 1,
        },
      },

      // Most recent first
      { $sort: { date: -1 } },
    ];

    const sales = await lubricantSaleModels.aggregate(pipeline).exec();

    return res.status(200).json({
      message: "Lubricant sales retrieved successfully",
      total: sales.length,
      data: sales,
    });
  } catch (err: any) {
    console.error("Error fetching lubricant sales:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};


// Update the getWeeklyLubricantSummaryCalendarWeek function to use transactions

export const getWeeklyLubricantSummaryCalendarWeek = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    // Calculate calendar week: Monday (00:00) -> Sunday (23:59:59.999)
    const now = new Date();
    const day = now.getDay();
    const diffToMonday = (day + 6) % 7;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - diffToMonday);
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const stationObjectId = new Types.ObjectId(fillingStation);

    // ðŸ”¥ NEW: Aggregation pipeline using transactions instead of lubricantsales
    const pipeline: any[] = [
      { $match: { fillingStation: stationObjectId } },

      {
        $addFields: {
          qtyInStockNum: {
            $convert: { input: "$qtyInStock", to: "double", onError: 0, onNull: 0 },
          },
          unitPriceNum: {
            $convert: { input: "$unitPrice", to: "double", onError: 0, onNull: 0 },
          },
        },
      },

      // ðŸ”¥ CHANGED: Lookup from lubricanttransactions instead
      {
        $lookup: {
          from: "lubricanttransactions",
          let: { lubricantId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$fillingStation", stationObjectId] },
                    { $gte: ["$createdAt", weekStart] },
                    { $lte: ["$createdAt", weekEnd] },
                  ],
                },
              },
            },
            // Unwind items array to process each item
            { $unwind: "$items" },
            // Match only items for this lubricant
            {
              $match: {
                $expr: { $eq: ["$items.lubricant", "$$lubricantId"] },
              },
            },
            // Sum up quantities sold
            {
              $group: {
                _id: null,
                qtySoldThisWeek: { $sum: "$items.qtySold" },
              },
            },
          ],
          as: "weeklySales",
        },
      },

      {
        $addFields: {
          qtySoldThisWeek: {
            $ifNull: [{ $arrayElemAt: ["$weeklySales.qtySoldThisWeek", 0] }, 0],
          },
        },
      },

      {
        $project: {
          _id: 0,
          lubricantId: "$_id",
          barcode: 1,
          productName: 1,
          productType: 1,
          qtyInStock: "$qtyInStockNum",
          unitPrice: "$unitPriceNum",
          qtySoldThisWeek: 1,
        },
      },

      { $sort: { qtySoldThisWeek: -1 } },
    ];

    const summary = await lubricantModel.aggregate(pipeline).exec();

    // Top three products by sales
    const topThree = summary.slice(0, 3);

    return res.status(200).json({
      message: "Weekly (calendar week Monâ†’Sun) lubricant summary retrieved successfully",
      period: {
        from: weekStart.toISOString(),
        to: weekEnd.toISOString(),
        note: "Calendar week (Monday 00:00 â†’ Sunday 23:59:59.999)",
      },
      totalLubricants: summary.length,
      data: summary,
      topThree,
    });
  } catch (err: any) {
    console.error("Error fetching weekly calendar-week summary:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// ðŸ”¥ NEW: Update getDailyLubricantSummary to use transactions too
export const getDailyLubricantSummary = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const stationObjectId = new Types.ObjectId(fillingStation);

    // ðŸ•’ Define today's range (midnight â†’ 23:59:59)
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    // ðŸ’° Calculate total amount sold today from transactions
    const salesToday = await LubricantTransaction.aggregate([
      {
        $match: {
          fillingStation: stationObjectId,
          createdAt: { $gte: startOfDay, $lte: endOfDay },
        },
      },
      {
        $group: {
          _id: null,
          totalAmountSold: { $sum: "$totalAmount" },
        },
      },
    ]);

    const totalAmountSold = salesToday[0]?.totalAmountSold || 0;

    // ðŸ§® Get lubricants data
    const lubricants = await lubricantModel.find({ fillingStation: stationObjectId }).lean();

    const totalLubricants = lubricants.length;

    // ðŸ’¼ Total inventory value (sum of qtyInStock * unitPrice)
    const totalInventoryValue = lubricants.reduce((sum, lube) => {
      const qty = Number(lube.qtyInStock) || 0;
      const price = Number(lube.unitPrice) || 0;
      return sum + qty * price;
    }, 0);

    // âš ï¸ Count of low-stock lubricants (qtyInStock < reOrderLevel)
    const lowStockCount = lubricants.filter(l => (Number(l.qtyInStock) || 0) < (Number(l.reOrderLevel) || 15)).length;

    // âœ… Response
    return res.status(200).json({
      message: "Daily lubricant summary retrieved successfully",
      date: startOfDay.toISOString().split("T")[0],
      summary: {
        totalAmountSold,
        totalLubricants,
        totalInventoryValue,
        lowStockCount,
      },
    });
  } catch (err: any) {
    console.error("Error in getDailyLubricantSummary:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
};

//get monthly transaction 
export const getMonthlyLubricantSummary = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    // Calculate current month: 1st day (00:00) -> Last day (23:59:59.999)
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    monthStart.setHours(0, 0, 0, 0);

    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    monthEnd.setHours(23, 59, 59, 999);

    const stationObjectId = new Types.ObjectId(fillingStation);

    // ðŸ”¥ Aggregation pipeline using transactions
    const pipeline: any[] = [
      { $match: { fillingStation: stationObjectId } },

      {
        $addFields: {
          qtyInStockNum: {
            $convert: { input: "$qtyInStock", to: "double", onError: 0, onNull: 0 },
          },
          unitPriceNum: {
            $convert: { input: "$unitPrice", to: "double", onError: 0, onNull: 0 },
          },
        },
      },

      // ðŸ”¥ Lookup from lubricanttransactions
      {
        $lookup: {
          from: "lubricanttransactions",
          let: { lubricantId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$fillingStation", stationObjectId] },
                    { $gte: ["$createdAt", monthStart] },
                    { $lte: ["$createdAt", monthEnd] },
                  ],
                },
              },
            },
            // Unwind items array to process each item
            { $unwind: "$items" },
            // Match only items for this lubricant
            {
              $match: {
                $expr: { $eq: ["$items.lubricant", "$$lubricantId"] },
              },
            },
            // Sum up quantities and amounts sold
            {
              $group: {
                _id: null,
                qtySoldThisMonth: { $sum: "$items.qtySold" },
                amountSoldThisMonth: { $sum: "$items.amount" },
              },
            },
          ],
          as: "monthlySales",
        },
      },

      {
        $addFields: {
          qtySoldThisMonth: {
            $ifNull: [{ $arrayElemAt: ["$monthlySales.qtySoldThisMonth", 0] }, 0],
          },
          amountSoldThisMonth: {
            $ifNull: [{ $arrayElemAt: ["$monthlySales.amountSoldThisMonth", 0] }, 0],
          },
        },
      },

      {
        $project: {
          _id: 0,
          lubricantId: "$_id",
          barcode: 1,
          productName: 1,
          productType: 1,
          qtyInStock: "$qtyInStockNum",
          unitPrice: "$unitPriceNum",
          qtySoldThisMonth: 1,
          amountSoldThisMonth: 1,
        },
      },

      { $sort: { qtySoldThisMonth: -1 } },
    ];

    const summary = await lubricantModel.aggregate(pipeline).exec();

    // Top three products by sales quantity
    const topThree = summary.slice(0, 3);

    // Calculate total monthly revenue
    const totalMonthlyRevenue = summary.reduce(
      (sum, item) => sum + (item.amountSoldThisMonth || 0),
      0
    );

    // Calculate total quantity sold
    const totalQuantitySold = summary.reduce(
      (sum, item) => sum + (item.qtySoldThisMonth || 0),
      0
    );

    return res.status(200).json({
      message: "Monthly lubricant summary retrieved successfully",
      period: {
        from: monthStart.toISOString(),
        to: monthEnd.toISOString(),
        month: monthStart.toLocaleString("en-US", { month: "long", year: "numeric" }),
      },
      summary: {
        totalLubricants: summary.length,
        totalQuantitySold,
        totalMonthlyRevenue: Number(totalMonthlyRevenue.toFixed(2)),
      },
      data: summary,
      topThree,
    });
  } catch (err: any) {
    console.error("Error fetching monthly summary:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const getLubricantSaleById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid sale id" });
    }

    const stationObjectId = new Types.ObjectId(fillingStation);
    const saleObjectId = new Types.ObjectId(id);

    const pipeline: any[] = [
      {
        $match: {
          _id: saleObjectId,
          fillingStation: stationObjectId,
        },
      },
      {
        $lookup: {
          from: "staffs",
          localField: "staff",
          foreignField: "_id",
          as: "staff",
        },
      },
      { $unwind: { path: "$staff", preserveNullAndEmptyArrays: true } },

      {
        $lookup: {
          from: "lubricants",
          localField: "lubricant",
          foreignField: "_id",
          as: "lubricant",
        },
      },
      { $unwind: { path: "$lubricant", preserveNullAndEmptyArrays: true } },

      {
        $project: {
          _id: 0,
          id: "$_id",
          date: "$createdAt",
          txnId: 1,
          staffId: "$staff._id",
          staffName: {
            $cond: [
              { $and: [{ $ifNull: ["$staff.firstName", false] }, { $ifNull: ["$staff.lastName", false] }] },
              { $concat: ["$staff.firstName", " ", "$staff.lastName"] },
              { $ifNull: ["$staff.firstName", { $ifNull: ["$staff.email", "Unknown Staff"] }] },
            ],
          },
          barcode: "$lubricant.barcode",
          productName: "$lubricant.productName",
          qtySold: 1,
          priceSold: 1,
          amountSold: { $multiply: ["$qtySold", "$priceSold"] },
          paymentMethod: 1,
        },
      },
    ];

    const results = await lubricantSaleModels.aggregate(pipeline).exec();

    if (!results || results.length === 0) {
      return res.status(404).json({ error: "Lubricant sale not found" });
    }

    return res.status(200).json({
      message: "Lubricant sale retrieved successfully",
      data: results[0],
    });
  } catch (err: any) {
    console.error("Error fetching lubricant sale by id:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};


// ðŸ†• NEW: Add grouped transaction sale
export const addLubricantTransaction = async (req: AuthenticatedRequest, res: Response) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const staffId = req.user?.id;
    const fillingStation = req.user?.station;
    const { items, paymentMethod, paymentBreakdown, idempotencyKey } = req.body;

    // ðŸ”’ Check authorization
    if (!fillingStation) {
      await session.abortTransaction();
      return res.status(403).json({ 
        success: false,
        error: "You are not authorized to perform this action" 
      });
    }

    // âœ… Validate input
    if (!items || !Array.isArray(items) || items.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false,
        error: "Items array is required and must not be empty" 
      });
    }

    if (!paymentMethod) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false,
        error: "Payment method is required" 
      });
    }

    const stationObjectId = new mongoose.Types.ObjectId(fillingStation);

    /**
     * Already recorded under this key? Hand back the sale that exists.
     *
     * The till sends the same key when it retries a basket, so a duplicate
     * request must return the ORIGINAL transaction — same txnId, so the receipt
     * that prints from the retry is the receipt for the sale that was made, not
     * a second sale for the same goods.
     */
    const replayKey = typeof idempotencyKey === "string" && idempotencyKey.trim()
      ? idempotencyKey.trim().slice(0, 100)
      : null;

    if (replayKey) {
      const existing = await LubricantTransaction.findOne({
        fillingStation: stationObjectId,
        idempotencyKey: replayKey,
      }).lean();

      if (existing) {
        await session.abortTransaction();
        return res.status(200).json({
          success: true,
          message: "Transaction already recorded",
          data: {
            txnId: existing.txnId,
            totalAmount: existing.totalAmount,
            itemCount: existing.items?.length ?? 0,
            transaction: existing,
          },
          duplicate: true,
        });
      }
    }

    const processedItems = [];
    let totalAmount = 0;

    // ðŸ”„ Process each item
    for (const item of items) {
      const { lubricantId, quantity, unitPrice, unitName } = item;

      if (!lubricantId || !quantity || !unitPrice) {
        await session.abortTransaction();
        return res.status(400).json({ 
          success: false,
          error: "Each item must have lubricantId, quantity, and unitPrice" 
        });
      }

      // ðŸ” Find the lubricant
      if (!Number.isFinite(quantity) || quantity <= 0) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          error: "Quantity must be greater than zero",
        });
      }

      /**
       * Which unit is being sold, and therefore how much stock leaves.
       *
       * The FACTOR is read from the product, never taken from the request. It
       * decides how many pieces come off the shelf, so a client able to name its
       * own factor could empty the shop with one number. The PRICE is still
       * whatever the till sends — cashiers discount, and that was always allowed.
       *
       * Selling by the base unit needs no lookup and no `unitName`: that is the
       * old behaviour, unchanged.
       */
      const productDoc = await lubricantModel
        .findOne({ _id: new mongoose.Types.ObjectId(lubricantId), fillingStation: stationObjectId })
        .session(session)
        .lean();

      if (!productDoc) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, error: `Lubricant not found: ${lubricantId}` });
      }

      // Registered at the till but never priced. Selling it would either charge
      // ₦0 or whatever the cashier typed, which is the hole the pending state
      // exists to close.
      if ((productDoc as any).pendingPricing) {
        await session.abortTransaction();
        return res.status(409).json({
          success: false,
          error: `${(productDoc as any).productName} has no price yet — a manager needs to set it before it can be sold.`,
        });
      }

      /**
       * Give the product its opening cost layer if it has never had one.
       *
       * Stations were selling long before consignment costs were tracked, so a
       * shelf can hold stock that no layer explains. Closing that gap here —
       * lazily, on first sale — means the FIFO ledger becomes correct as the
       * shop trades instead of waiting on a migration someone has to remember
       * to run. Deliberately outside the session: it is idempotent, and a race
       * between two tills must not abort a customer's sale.
       */
      await ensureOpeningBatch(productDoc, stationObjectId).catch((e) =>
        console.error("Opening batch error:", e?.message)
      );

      const baseUnitName = (productDoc as any).baseUnit || "piece";
      const asked = String(unitName || "").trim();
      const sellingBase = !asked || asked.toLowerCase() === baseUnitName.toLowerCase();

      const saleUnit = sellingBase
        ? null
        : ((productDoc as any).saleUnits || []).find(
            (u: any) => String(u.name).toLowerCase() === asked.toLowerCase()
          );

      if (!sellingBase && !saleUnit) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          error: `${(productDoc as any).productName} is not sold by the ${asked}.`,
        });
      }

      const unitFactor = saleUnit ? Number(saleUnit.factor) : 1;
      // What actually leaves the shelf: 2 packs of 12 is 24 pieces.
      const baseQty = quantity * unitFactor;

      /**
       * Claim the stock ATOMICALLY.
       *
       * This used to read the product, compare quantities in JavaScript, then
       * write back `currentQty - quantity`. Two cashiers selling the last bottle
       * at the same moment both read 1, both passed the check, and both wrote 0
       * - two sales, one bottle, and a stock count that silently disagreed with
       * the shelf. On a busy forecourt with two tills that is not a rare race.
       *
       * `qtyInStock: { $gte: baseQty }` moves the check INTO the update, so the
       * database evaluates and decrements in one indivisible operation. The
       * second cashier's filter simply does not match, and they get a clean
       * "only N available" instead of an oversell.
       *
       * The guard is in BASE units, so a pack cannot be sold out of eleven
       * loose bottles.
       */
      const lubricant = await lubricantModel.findOneAndUpdate(
        {
          _id: new mongoose.Types.ObjectId(lubricantId),
          fillingStation: stationObjectId,
          qtyInStock: { $gte: baseQty },
        },
        { $inc: { qtyInStock: -baseQty } },
        { new: true, session }
      );

      if (!lubricant) {
        // The claim failed. Read the product back only to explain WHY - a
        // missing product and an insufficient one need different messages.
        const existing = await lubricantModel
          .findOne({
            _id: new mongoose.Types.ObjectId(lubricantId),
            fillingStation: stationObjectId,
          })
          .session(session)
          .lean();

        await session.abortTransaction();

        if (!existing) {
          return res.status(404).json({
            success: false,
            error: `Lubricant not found: ${lubricantId}`,
          });
        }
        if ((existing.qtyInStock ?? 0) <= 0) {
          return res.status(400).json({
            success: false,
            error: `Out of stock: ${existing.productName}`,
          });
        }
        // Said in the unit they tried to sell, plus the shelf count in base
        // units — "1 Pack needs 12 pieces, there are 7" is actionable; "cannot
        // sell 1, only 7 available" reads like a bug.
        const unitLabel = saleUnit ? `${quantity} × ${saleUnit.name}` : `${quantity} ${baseUnitName}(s)`;
        return res.status(409).json({
          success: false,
          error: saleUnit
            ? `Cannot sell ${unitLabel} of ${existing.productName} — that needs ${baseQty} ${baseUnitName}(s) and only ${existing.qtyInStock} are in stock.`
            : `Cannot sell ${unitLabel} of ${existing.productName}. Only ${existing.qtyInStock} available.`,
          available: existing.qtyInStock,
        });
      }


      /**
       * Take the goods off the oldest layers and record WHICH ones went.
       *
       * Inside the session, so a basket that fails on its third line does not
       * leave the first two lines' layers consumed. This is what makes a sale
       * traceable back to the invoice that brought the goods in, and what makes
       * the margin on the line the real margin rather than one computed against
       * whatever the product happens to cost today.
       */
      const consumed = await consumeFIFO({ product: lubricant, qty: baseQty, session });

      // Low-stock alert when quantity drops to or below reorder level
      const newQty = lubricant.qtyInStock;
      const reOrder = lubricant.reOrderLevel || 0;
      if (reOrder > 0 && newQty <= reOrder) {
        // Owner + every hired manager (see the "manager" audience rule), pushed
        // live rather than waiting for the next bell poll.
        notifyStation(stationObjectId, {
          type: "alert",
          category: "low_stock",
          title: (lubricant as any).category && (lubricant as any).category !== "lubricant"
            ? "Store Low Stock"
            : "Lubricant Low Stock",
          body: lubricant.productName + " is running low — " + newQty + " unit(s) remaining (reorder level: " + reOrder + ").",
          severity: newQty === 0 ? "critical" : "warning",
          targetRole: "manager",
          expiresInDays: 1,
        });
      }

      // ðŸ“ Prepare item for transaction
      const amount = quantity * unitPrice;
      processedItems.push({
        lubricant: lubricant._id,
        productName: lubricant.productName,
        barcode: lubricant.barcode,
        // Snapshot, not a reference: recategorising a product next month must
        // not move revenue that has already been posted to the ledger.
        category: (lubricant as any).category || "lubricant",
        // Base-unit figures — what every report, valuation and margin
        // calculation downstream reasons in. A pack discount lands here as a
        // lower effective price per piece, which is exactly what it is.
        priceSold: parseFloat((amount / baseQty).toFixed(4)),
        qtySold: baseQty,
        amount,
        // …and the same sale in the words used at the counter, so the receipt
        // and the day's sales say "2 Packs", not "24 pieces".
        unitName: saleUnit ? saleUnit.name : baseUnitName,
        unitFactor,
        qtyInUnits: quantity,
        unitPrice,
        // The specific consignments this sale drew on, and what they cost.
        costLots: consumed.lots.map((l) => ({
          batch: l.batch ?? undefined,
          source: l.source,
          reference: l.reference,
          supplier: l.supplier,
          unitCost: l.unitCost,
          qty: l.qty,
          receivedAt: l.receivedAt,
        })),
        costOfGoods: consumed.costOfGoods,
        costEstimated: consumed.estimated,
      });

      totalAmount += amount;
    }

    // ðŸ§¾ Create the transaction
    const transaction = await LubricantTransaction.create(
      [
        {
          fillingStation: stationObjectId,
          staff: staffId,
          items: processedItems,
          totalAmount,
          paymentMethod,
          ...(replayKey ? { idempotencyKey: replayKey } : {}),
          ...(paymentMethod === "mixed" && paymentBreakdown
            ? { paymentBreakdown }
            : {}),
        },
      ],
      { session }
    );

    await session.commitTransaction();

    // Log sale activity (fire-and-forget)
    console.log("ðŸ”” About to create activity for lubricant sale");
    // Reads back the way it was sold: "Coke ×2 Pack", not "Coke ×24".
    const itemSummary = processedItems
      .map((i) => `${i.productName} Ã—${i.qtyInUnits} ${i.unitName}${i.qtyInUnits > 1 ? "s" : ""}`)
      .join(", ");
    Activity.create({
      ...actorFrom(req.user),
      fillingStation: stationObjectId,
      type: "sale",
      title: `Sale completed - ${processedItems.length > 1 ? `${processedItems.length} items` : processedItems[0].productName}`,
      description: `${itemSummary} sold`,
      timestamp: new Date(),
      severity: null,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
      .then(() => console.log("âœ… Activity created successfully"))
      .catch((err) => console.error("Activity log error (addLubricantTransaction):", err));

    const stationId = req.user?.station?.toString();
    if (stationId) {
      emitToStation(stationId, "lubricant:sold", { totalAmount, itemCount: processedItems.length });
      emitToStation(stationId, "dashboard:refresh", { reason: "lubricant_sold" });
    }

    return res.status(201).json({
      success: true,
      message: "Transaction recorded successfully",
      data: {
        txnId: transaction[0].txnId,
        totalAmount,
        itemCount: processedItems.length,
        transaction: transaction[0],
      },
    });
  } catch (error: any) {
    await session.abortTransaction();

    // Read from the body, not the destructured const — that one is scoped to
    // the try block and is not in scope here.
    const retriedKey = req.body?.idempotencyKey;

    if (error?.code === 11000 && typeof retriedKey === "string" && req.user?.station) {
      const winner = await LubricantTransaction.findOne({
        fillingStation: new mongoose.Types.ObjectId(req.user.station),
        idempotencyKey: retriedKey.trim().slice(0, 100),
      }).lean();

      if (winner) {
        return res.status(200).json({
          success: true,
          message: "Transaction already recorded",
          data: {
            txnId: winner.txnId,
            totalAmount: winner.totalAmount,
            itemCount: winner.items?.length ?? 0,
            transaction: winner,
          },
          duplicate: true,
        });
      }
    }

    console.error("Error adding lubricant transaction:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  } finally {
    session.endSession();
  }
};

// ðŸ†• Get all transactions (grouped sales)
export const getAllLubricantTransactions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const transactions = await LubricantTransaction.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(fillingStation),
        },
      },
      {
        $lookup: {
          from: "staffs",
          localField: "staff",
          foreignField: "_id",
          as: "staff",
        },
      },
      { $unwind: { path: "$staff", preserveNullAndEmptyArrays: true } },
      
      {
        $project: {
          _id: 0,
          transactionId: "$_id",
          txnId: 1,
          date: "$createdAt",
          staffName: {
            $cond: [
              { 
                $and: [
                  { $ifNull: ["$staff.firstName", false] }, 
                  { $ifNull: ["$staff.lastName", false] }
                ] 
              },
              { $concat: ["$staff.firstName", " ", "$staff.lastName"] },
              { $ifNull: ["$staff.firstName", { $ifNull: ["$staff.email", "Unknown Staff"] }] },
            ],
          },
          items: 1,
          totalAmount: 1,
          paymentMethod: 1,
          paymentBreakdown: 1,
          itemCount: { $size: "$items" },
        },
      },
      
      { $sort: { date: -1 } },
    ]).exec();

    return res.status(200).json({
      message: "Transactions retrieved successfully",
      total: transactions.length,
      data: transactions,
    });
  } catch (err: any) {
    console.error("Error fetching transactions:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// ðŸ†• Get single transaction by ID
export const getLubricantTransactionById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid transaction id" });
    }

    const transaction = await LubricantTransaction.findOne({
      _id: new Types.ObjectId(id),
      fillingStation: new Types.ObjectId(fillingStation),
    })
      .populate("staff", "firstName lastName email")
      .populate("fillingStation", "name address phone email")
      .lean();

    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    return res.status(200).json({
      message: "Transaction retrieved successfully",
      data: transaction,
    });
  } catch (err: any) {
    console.error("Error fetching transaction:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};


