import mongoose, { Document, Schema } from "mongoose";

export interface ISalesTarget extends Document {
  _id: mongoose.Types.ObjectId;
  staff: mongoose.Types.ObjectId;
  fillingStation: mongoose.Types.ObjectId;
  targetAmount: number;
  duration: "Daily" | "Weekly" | "Monthly" | "Quarterly";
  startDate: Date;
  endDate: Date;
  currentProgress: number;
  status: "Active" | "Met" | "Exceeded" | "Expired";
  metAt?: Date;
  notificationSent: boolean;
}

const salesTargetSchema = new Schema<ISalesTarget>(
  {
    staff: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    fillingStation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
    },
    targetAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    duration: {
      type: String,
      enum: ["Daily", "Weekly", "Monthly", "Quarterly"],
      required: true,
    },
    startDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    endDate: {
      type: Date,
      required: true,
    },
    currentProgress: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ["Active", "Met", "Exceeded", "Expired"],
      default: "Active",
    },
    metAt: {
      type: Date,
    },
    notificationSent: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// Pre-save hook: auto-calculate endDate from duration + startDate when creating a new record
salesTargetSchema.pre("save", function (next) {
  if (this.isNew && !this.endDate) {
    const start = this.startDate ? new Date(this.startDate) : new Date();
    const end = new Date(start);

    switch (this.duration) {
      case "Daily":
        end.setDate(end.getDate() + 1);
        break;
      case "Weekly":
        end.setDate(end.getDate() + 7);
        break;
      case "Monthly":
        end.setDate(end.getDate() + 30);
        break;
      case "Quarterly":
        end.setDate(end.getDate() + 90);
        break;
    }

    this.endDate = end;
  }
  next();
});

salesTargetSchema.index({ staff: 1, status: 1 });
salesTargetSchema.index({ fillingStation: 1, status: 1 });
salesTargetSchema.index({ endDate: 1, status: 1 });

const SalesTarget = mongoose.model<ISalesTarget>("SalesTarget", salesTargetSchema);
export default SalesTarget;
