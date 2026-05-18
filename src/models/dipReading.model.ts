import mongoose, { Document, Schema } from "mongoose";

export interface IDipReading extends Document {
  _id: mongoose.Types.ObjectId;
  fillingStation: mongoose.Types.ObjectId;
  tank: mongoose.Types.ObjectId; // Reference to tank._id
  tankTitle: string; // e.g., "Tank A"
  fuelType: string; // "Petrol", "Diesel", "Kerosene", "Gas", "PMS", "AGO"
  systemReading: number; // System reading at time of manual reading
  manualReading: number; // Manual dip reading
  deviation: number; // manualReading - systemReading (can be positive or negative)
  status: "Pending" | "Matched" | "Deviation"; // Status based on comparison
  recordedBy: mongoose.Types.ObjectId; // Staff who recorded the reading
  notes?: string;
  readingDate: Date;
  createdAt: Date;
  updatedAt: Date;
}

const dipReadingSchema = new Schema<IDipReading>(
  {
    fillingStation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
    },
    tank: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    tankTitle: {
      type: String,
      required: true,
      trim: true,
    },
    fuelType: {
      type: String,
      required: true,
      enum: ["Petrol", "Diesel", "Kerosene", "PMS", "AGO"],
    },
    systemReading: {
      type: Number,
      required: true,
      min: 0,
    },
    manualReading: {
      type: Number,
      required: true,
      min: 0,
    },
    deviation: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ["Pending", "Matched", "Deviation"],
      default: "Pending",
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    notes: {
      type: String,
      trim: true,
    },
    readingDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Calculate deviation and set status before saving
dipReadingSchema.pre("save", function (next) {
  this.deviation = this.manualReading - this.systemReading;
  
  // Auto-set status based on deviation
  if (this.deviation === 0) {
    this.status = "Matched";
  } else if (this.deviation !== 0) {
    this.status = "Deviation";
  }
  
  next();
});

// Index for faster queries
dipReadingSchema.index({ fillingStation: 1, readingDate: -1 });
dipReadingSchema.index({ tank: 1, readingDate: -1 });

const DipReading = mongoose.model<IDipReading>("DipReading", dipReadingSchema);
export default DipReading;


