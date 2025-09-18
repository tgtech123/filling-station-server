import mongoose, { Schema, Document } from "mongoose";

export interface IFillingStation extends Document {
  name: string;
  address: string;
  email: string;
  phone: string;
  city: string;
  country: string;
  zipCode: string;
  licenseNumber: string;
  taxId: string;
  establishmentDate: Date;
  image?: string;
  businessType: string;
  numberOfPumps: number;
  operationHours: string;
  tankCapacity: string;
  averageMonthlyRevenue: string;
  fuelTypesOffered: string[];
  additionalServices: string[];
  staff: mongoose.Types.ObjectId[]; // references to Staff
}

const FillingStationSchema = new Schema<IFillingStation>(
  {
    name: { type: String, required: true },
    address: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    city: { type: String, required: true },
    country: { type: String, required: true },
    zipCode: { type: String, required: true },
    licenseNumber: { type: String, required: true, unique: true },
    taxId: { type: String, required: true },
    establishmentDate: { type: Date, required: true },
    image: { type: String },
    businessType: { type: String, required: true },
    numberOfPumps: { type: Number, required: true },
    operationHours: { type: String, required: true },
    tankCapacity: { type: String, required: true },
    averageMonthlyRevenue: { type: String, required: true },
    fuelTypesOffered: { type: [String], default: [] },
    additionalServices: { type: [String], default: [] },
    staff: [{ type: Schema.Types.ObjectId, ref: "Staff" }],
  },
  { timestamps: true }
);

export default mongoose.model<IFillingStation>("FillingStation", FillingStationSchema);
