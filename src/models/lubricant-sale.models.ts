import mongoose, { Document, Schema } from "mongoose";

// export interface ILubricantSale extends Document {
//   fillingStation: mongoose.Types.ObjectId;
//   lubricant: mongoose.Types.ObjectId;
//   staff: mongoose.Types.ObjectId;
//   paymentMethod: "cash" | "transfer" | "POS";
//   priceSold: number;
//   qtySold: number;
//   txnId: string;
//   createdAt: Date;
//   updatedAt: Date;
// }

// const lubricantSaleSchema = new Schema<ILubricantSale>(
//   {
//     fillingStation: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: "FillingStation",
//       required: true,
//     },
//     lubricant: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: "Lubricant",
//       required: true,
//     },
//     staff: {
//       type: mongoose.Schema.Types.ObjectId,
//       ref: "Staff",
//       required: true,
//     },
//     paymentMethod: {
//       type: String,
//       enum: ["cash", "transfer", "POS"],
//       required: true,
//     },
//     priceSold: {
//       type: Number,
//       required: true,
//     },
//     qtySold: {
//       type: Number,
//       required: true,
//     },
//     txnId: {
//       type: String,
//       unique: true,
//       required: true,
//     },
//   },
//   { timestamps: true }
// );




export interface ILubricantSale extends Document {
  fillingStation: mongoose.Types.ObjectId;
  lubricant: mongoose.Types.ObjectId;
  staff: mongoose.Types.ObjectId;
  paymentMethod: "cash" | "transfer" | "POS" | "mixed";
  priceSold: number;
  qtySold: number;
  paymentBreakdown?: {
    cash?: number;
    transfer?: number;
    POS?: number;
  };
  txnId: string;
  createdAt: Date;
  updatedAt: Date;
}

const lubricantSaleSchema = new Schema<ILubricantSale>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    lubricant: { type: Schema.Types.ObjectId, ref: "Lubricant", required: true },
    staff: { type: Schema.Types.ObjectId, ref: "Staff", required: true },

    paymentMethod: {
      type: String,
      enum: ["cash", "transfer", "POS", "mixed"],
      required: true,
    },

    // ⭐ New attribute
    paymentBreakdown: {
      cash: { type: Number, default: 0 },
      transfer: { type: Number, default: 0 },
      POS: { type: Number, default: 0 },
    },

    priceSold: { type: Number, required: true },
    qtySold: { type: Number, required: true },

    txnId: { type: String, unique: true, required: true },
  },
  { timestamps: true }
);


// 🔹 Generate unique txnId like "LUB29933"
lubricantSaleSchema.pre("validate", async function (next) {
  if (!this.txnId) {
    const randomNum = Math.floor(10000 + Math.random() * 90000);
    this.txnId = `LUB${randomNum}`;
  }
  next();
});

const LubricantSale = mongoose.model<ILubricantSale>("LubricantSale", lubricantSaleSchema);
export default LubricantSale;