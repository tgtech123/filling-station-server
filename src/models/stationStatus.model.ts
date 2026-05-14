import mongoose, { Document, Schema } from "mongoose";

export interface IStationStatus extends Document {
  _id: mongoose.Types.ObjectId;
  fillingStation: mongoose.Types.ObjectId;
  emergencyMode: boolean;
  activatedBy: mongoose.Types.ObjectId | null;
  activatedAt: Date | null;
  reason: string | null;
}

const StationStatusSchema = new Schema<IStationStatus>(
  {
    fillingStation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
      unique: true,
    },
    emergencyMode: {
      type: Boolean,
      default: false,
    },
    activatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },
    activatedAt: {
      type: Date,
      default: null,
    },
    reason: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

const StationStatus = mongoose.model<IStationStatus>("StationStatus", StationStatusSchema);
export default StationStatus;
