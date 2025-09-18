import mongoose, { Schema, Document } from "mongoose";


export interface IStaff extends Document {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  emergencyContact: string;
  image?: string;
  role: "manager" | "supervisor" | "accountant" | "cashier" | "attendant";
  station: mongoose.Types.ObjectId;
  password: string;
  twoFactorAuthEnabled: boolean;
  notificationPreferences: {
    email: boolean;
    sms: boolean;
    push: boolean;
    lowStock: boolean;
    mail: boolean;
    sales: boolean;
    staffs: boolean;
  };
}

const StaffSchema = new Schema<IStaff>(
  {
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true },
    address: { type: String, required: true },
    city: { type: String, required: true },
    state: { type: String, required: true },
    zipCode: { type: String, required: true },
    emergencyContact: { type: String, required: true },
    image: { type: String },
    role: {
      type: String,
      enum: ["manager", "supervisor", "accountant", "cashier", "attendant"],
      required: true,
    },
    station: { type: Schema.Types.ObjectId, ref: "FillingStation" },
    password: { type: String, required: true },
    twoFactorAuthEnabled: { type: Boolean, default: false },
    notificationPreferences: {
      email: { type: Boolean, default: false },
      sms: { type: Boolean, default: false },
      push: { type: Boolean, default: false },
      lowStock: { type: Boolean, default: false },
      mail: { type: Boolean, default: false },
      sales: { type: Boolean, default: false },
      staffs: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

export default mongoose.model<IStaff>("Staff", StaffSchema);
