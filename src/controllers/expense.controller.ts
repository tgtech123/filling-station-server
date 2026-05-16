import { Response } from "express";
import mongoose, { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import Expense from "../models/expense.model";
import Staff from "../models/staff.model";

/**
 * GET /api/expenses
 * Get all expenses with pagination, filtering, and sorting
 */
export const getAllExpenses = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const stationObjectId = new Types.ObjectId(fillingStation);

    // Query parameters
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const status = req.query.status as string;
    const category = req.query.category as string;
    const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

    // Build filter
    const filter: any = { fillingStation: stationObjectId };

    if (status) {
      filter.status = status;
    }

    if (category) {
      filter.category = category;
    }

    if (startDate || endDate) {
      filter.expenseDate = {};
      if (startDate) filter.expenseDate.$gte = startDate;
      if (endDate) {
        endDate.setHours(23, 59, 59, 999);
        filter.expenseDate.$lte = endDate;
      }
    }

    // Get total count
    const total = await Expense.countDocuments(filter);

    // Get expenses with pagination and populate submittedBy
    const expenses = await Expense.find(filter)
      .populate("submittedBy", "firstName lastName email")
      .populate("approvedBy", "firstName lastName email")
      .sort({ expenseDate: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Format response
    const formattedExpenses = expenses.map((expense: any) => ({
      _id: expense._id,
      date: expense.expenseDate
        ? new Date(expense.expenseDate).toLocaleDateString("en-US", {
            month: "2-digit",
            day: "2-digit",
            year: "2-digit",
          })
        : "",
      expId: expense.expId,
      category: expense.category,
      description: expense.description,
      amount: expense.amount,
      submittedBy: expense.submittedBy
        ? `${expense.submittedBy.firstName} ${expense.submittedBy.lastName} - ${expense.submittedBy.role || "Staff"}`
        : "Unknown",
      status: expense.status,
      approvedBy: expense.approvedBy
        ? `${expense.approvedBy.firstName} ${expense.approvedBy.lastName}`
        : null,
      approvedAt: expense.approvedAt || null,
      rejectionReason: expense.rejectionReason || null,
      createdAt: expense.createdAt,
      updatedAt: expense.updatedAt,
    }));

    return res.status(200).json({
      message: "Expenses retrieved successfully",
      data: formattedExpenses,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err: any) {
    console.error("Error in getAllExpenses:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * POST /api/expenses
 * Create a new expense (request for approval)
 */
export const createExpense = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const staffId = req.user?.id;

    if (!fillingStation || !staffId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { category, description, amount, vatAmount, expenseDate } = req.body;

    // Validate required fields
    if (!category || !description || !amount) {
      return res.status(400).json({
        error: "Missing required fields. Provide category, description, and amount.",
      });
    }

    // Validate category
    const validCategories = [
      "Product purchase",
      "Maintenance & Repair",
      "Salaries",
      "Operational",
      "Utilities",
      "Administrative",
      "Depreciation",
      "Other Expenses",
    ];

    if (!validCategories.includes(category)) {
      return res.status(400).json({ error: "Invalid category" });
    }

    // Validate amount
    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: "Amount must be a positive number" });
    }

    const vatAmountNum = vatAmount ? Number(vatAmount) : 0;
    if (isNaN(vatAmountNum) || vatAmountNum < 0) {
      return res.status(400).json({ error: "VAT amount must be zero or a positive number" });
    }

    // Validate expense date or use current date
    const date = expenseDate ? new Date(expenseDate) : new Date();

    // Create expense
    const newExpense = await Expense.create({
      fillingStation: new Types.ObjectId(fillingStation),
      category,
      description: description.trim(),
      amount: amountNum,
      vatAmount: vatAmountNum,
      submittedBy: new Types.ObjectId(staffId),
      status: "Pending",
      expenseDate: date,
    });

    // Populate submittedBy
    await newExpense.populate("submittedBy", "firstName lastName email");

    return res.status(201).json({
      message: "Expense request created successfully",
      data: newExpense,
    });
  } catch (err: any) {
    console.error("Error in createExpense:", err);
    if (err?.code === 11000) {
      return res.status(409).json({ error: "Duplicate expense ID detected" });
    }
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * PUT /api/expenses/:id
 * Update expense (approve, reject, or update details)
 */
export const updateExpense = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const staffId = req.user?.id;
    const userRole = req.user?.role;

    if (!fillingStation || !staffId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const expenseId = req.params.id;
    const { status, category, description, amount, vatAmount, expenseDate, rejectionReason } = req.body;

    // Validate expense ID
    if (!Types.ObjectId.isValid(expenseId)) {
      return res.status(400).json({ error: "Invalid expense ID" });
    }

    // Find expense
    const expense = await Expense.findOne({
      _id: expenseId,
      fillingStation: fillingStation,
    });

    if (!expense) {
      return res.status(404).json({ error: "Expense not found" });
    }

    // Only managers and accountants can approve/reject
    if (status && status !== expense.status) {
      if (status === "Approved" || status === "Rejected") {
        if (userRole !== "manager" && userRole !== "accountant") {
          return res.status(403).json({
            error: "Only managers and accountants can approve or reject expenses",
          });
        }

        expense.status = status;
        expense.approvedBy = new Types.ObjectId(staffId);
        expense.approvedAt = new Date();

        if (status === "Rejected" && rejectionReason) {
          expense.rejectionReason = rejectionReason.trim();
        } else if (status === "Approved") {
          expense.rejectionReason = undefined;
        }
      } else if (status === "Pending") {
        // Allow resubmission (set back to pending)
        expense.status = "Pending";
        expense.approvedBy = undefined;
        expense.approvedAt = undefined;
        expense.rejectionReason = undefined;
      }
    }

    // Update other fields (only if expense is pending or user is owner)
    if (expense.status === "Pending" || expense.submittedBy.toString() === staffId) {
      if (category) {
        const validCategories = [
          "Product purchase",
          "Maintenance & Repair",
          "Salaries",
          "Operational",
          "Utilities",
          "Administrative",
          "Depreciation",
          "Other Expenses",
        ];
        if (validCategories.includes(category)) {
          expense.category = category;
        }
      }

      if (description) {
        expense.description = description.trim();
      }

      if (amount !== undefined) {
        const amountNum = Number(amount);
        if (!isNaN(amountNum) && amountNum > 0) {
          expense.amount = amountNum;
        }
      }

      if (vatAmount !== undefined) {
        const vatNum = Number(vatAmount);
        if (!isNaN(vatNum) && vatNum >= 0) {
          (expense as any).vatAmount = vatNum;
        }
      }

      if (expenseDate) {
        expense.expenseDate = new Date(expenseDate);
      }
    } else {
      // If expense is approved/rejected, only managers can update
      if (userRole !== "manager") {
        return res.status(403).json({
          error: "Cannot update approved/rejected expenses. Only managers can update them.",
        });
      }

      // Managers can update any field
      if (category) expense.category = category;
      if (description) expense.description = description.trim();
      if (amount !== undefined) {
        const amountNum = Number(amount);
        if (!isNaN(amountNum) && amountNum > 0) {
          expense.amount = amountNum;
        }
      }
      if (expenseDate) expense.expenseDate = new Date(expenseDate);
    }

    await expense.save();

    // Populate fields
    await expense.populate("submittedBy", "firstName lastName email");
    await expense.populate("approvedBy", "firstName lastName email");

    return res.status(200).json({
      message: "Expense updated successfully",
      data: expense,
    });
  } catch (err: any) {
    console.error("Error in updateExpense:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * DELETE /api/expenses/:id
 * Delete an expense (only if pending)
 */
export const deleteExpense = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const staffId = req.user?.id;
    const userRole = req.user?.role;

    if (!fillingStation || !staffId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const expenseId = req.params.id;

    // Validate expense ID
    if (!Types.ObjectId.isValid(expenseId)) {
      return res.status(400).json({ error: "Invalid expense ID" });
    }

    // Find expense
    const expense = await Expense.findOne({
      _id: expenseId,
      fillingStation: fillingStation,
    });

    if (!expense) {
      return res.status(404).json({ error: "Expense not found" });
    }

    // Only allow deletion if:
    // 1. Expense is pending, OR
    // 2. User is manager, OR
    // 3. User is the submitter
    if (expense.status !== "Pending" && userRole !== "manager" && expense.submittedBy.toString() !== staffId) {
      return res.status(403).json({
        error: "Cannot delete approved/rejected expenses. Only managers or the submitter can delete pending expenses.",
      });
    }

    await Expense.findByIdAndDelete(expenseId);

    return res.status(200).json({
      message: "Expense deleted successfully",
    });
  } catch (err: any) {
    console.error("Error in deleteExpense:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * GET /api/expenses/:id
 * Get a single expense by ID
 */
export const getExpenseById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;

    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const expenseId = req.params.id;

    // Validate expense ID
    if (!Types.ObjectId.isValid(expenseId)) {
      return res.status(400).json({ error: "Invalid expense ID" });
    }

    const expense = await Expense.findOne({
      _id: expenseId,
      fillingStation: fillingStation,
    })
      .populate("submittedBy", "firstName lastName email role")
      .populate("approvedBy", "firstName lastName email role")
      .lean();

    if (!expense) {
      return res.status(404).json({ error: "Expense not found" });
    }

    return res.status(200).json({
      message: "Expense retrieved successfully",
      data: expense,
    });
  } catch (err: any) {
    console.error("Error in getExpenseById:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * GET /api/expenses/export
 * Export expenses to CSV/Excel format
 */
export const exportExpenses = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;

    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const stationObjectId = new Types.ObjectId(fillingStation);
    const status = req.query.status as string;
    const category = req.query.category as string;
    const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

    // Build filter
    const filter: any = { fillingStation: stationObjectId };

    if (status) filter.status = status;
    if (category) filter.category = category;

    if (startDate || endDate) {
      filter.expenseDate = {};
      if (startDate) filter.expenseDate.$gte = startDate;
      if (endDate) {
        endDate.setHours(23, 59, 59, 999);
        filter.expenseDate.$lte = endDate;
      }
    }

    // Get all expenses
    const expenses = await Expense.find(filter)
      .populate("submittedBy", "firstName lastName email")
      .populate("approvedBy", "firstName lastName email")
      .sort({ expenseDate: -1, createdAt: -1 })
      .lean();

    // Format for CSV/Excel
    const csvData = expenses.map((expense: any) => ({
      "EXP ID": expense.expId,
      Date: expense.expenseDate
        ? new Date(expense.expenseDate).toLocaleDateString("en-US")
        : "",
      Category: expense.category,
      Description: expense.description,
      Amount: expense.amount,
      "Submitted By": expense.submittedBy
        ? `${expense.submittedBy.firstName} ${expense.submittedBy.lastName}`
        : "Unknown",
      Status: expense.status,
      "Approved By": expense.approvedBy
        ? `${expense.approvedBy.firstName} ${expense.approvedBy.lastName}`
        : "",
      "Approved At": expense.approvedAt ? new Date(expense.approvedAt).toLocaleString() : "",
      "Rejection Reason": expense.rejectionReason || "",
    }));

    return res.status(200).json({
      message: "Expenses exported successfully",
      data: csvData,
      total: csvData.length,
    });
  } catch (err: any) {
    console.error("Error in exportExpenses:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

