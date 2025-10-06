import mongoose, { Schema, Model, Document } from "mongoose";

export interface IDelivery extends Document {
  fillingStation: mongoose.Types.ObjectId;
  tank: mongoose.Types.ObjectId;
  pricePerLtr: number;
  quantity: number;
  suplier: string;
  deliveryDate: Date;
  status: "Pending" | "Completed" | "Cancelled";
}

const DeliverySchema = new Schema<IDelivery>(
  {
    fillingStation: {
      type: Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
    },
    tank: {
      type: Schema.Types.ObjectId,
      ref: "Tank",
      required: true,
    },
    pricePerLtr: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    suplier: {
      type: String,
      required: true,
      trim: true,
    },
    deliveryDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["Pending", "Completed", "Cancelled"],
      default: "Pending",
    },
  },
  { timestamps: true }
);

const Delivery: Model<IDelivery> = mongoose.model<IDelivery>("Delivery", DeliverySchema);

export default Delivery;
