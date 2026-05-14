import mongoose, { Document, Schema } from "mongoose";

export interface IBonusStructure extends Document {
  _id: mongoose.Types.ObjectId;
  fillingStation: mongoose.Types.ObjectId;
  achievement: string; // e.g., "Monthly Sales Target", "Zero discrepancies", "Top performer"
  bonusAmount: number;
  frequency: "Monthly" | "Quarterly" | "Yearly" | "One-time";
  createdAt: Date;
  updatedAt: Date;
}

const bonusStructureSchema = new Schema<IBonusStructure>(
  {
    fillingStation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
    },
    achievement: {
      type: String,
      required: true,
      trim: true,
    },
    bonusAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    frequency: {
      type: String,
      enum: ["Monthly", "Quarterly", "Yearly", "One-time"],
      required: true,
    },
  },
  { timestamps: true }
);

const BonusStructure = mongoose.model<IBonusStructure>("BonusStructure", bonusStructureSchema);
export default BonusStructure;
