import mongoose, { Schema, Document } from "mongoose";


export interface IStaff extends Document {
  _id: mongoose.Types.ObjectId;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  emergencyContact?: string;
  image?: string;
  role: "manager" | "supervisor" | "accountant" | "cashier" | "attendant" | "admin";
  station: mongoose.Types.ObjectId;
  password: string;
  shiftType?: string; // built-in or station-defined custom type (ShiftTypeDef.name)
  responsibility: string[];
  addSaleTarget?: boolean;
  payType?: string;
  amount: number;
  taxPercentage?: number;
  bankDetails?: { acctNo: string; acctName: string; bankName: string };
  onDuty?: boolean;
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
  managedStations: mongoose.Types.ObjectId[];
  isSuperManager: boolean;
  /**
   * The station OWNER — the person who registered the business. Exactly one per
   * root station (the manager created by createFillingStation). Every other
   * `manager` is a HIRED manager: they run day-to-day operations but must not
   * reach the owner's controls (billing, payroll, pay structures, other
   * managers, station identity).
   *
   * This is the authoritative flag. `isSuperManager` in the JWT is derived from
   * it — do not infer ownership from `role === "manager"`, which is true for
   * hired managers too.
   */
  isOwner: boolean;
  /**
   * Group accountant — the chain's CFO / financial controller.
   *
   * An accountant carrying this flag sits at the HEAD-OFFICE station and may act
   * as the approving checker for any branch beneath it. It is a flag rather than
   * a new role because `role` drives plan staff limits, the sidebar, department
   * confinement and dozens of checkRole() gates; a flag adds the capability
   * without disturbing any of them — the same reasoning as [isOwner].
   *
   * It grants APPROVAL rights across the chain only. It never lets its holder
   * create entries in a branch, so the maker and the checker stay distinct.
   */
  isGroupAccountant: boolean;
  /**
   * The real address, parked here while the account's station is deleted.
   *
   * `email` is uniquely indexed, so a staff record left behind by a deleted
   * station keeps its address reserved forever — the owner could never sign up
   * again with the same email even though nothing usable remained. On delete
   * the address moves here and `email` becomes a tombstone; on restore it moves
   * back. Nothing is destroyed, and the address is free in the meantime.
   */
  releasedEmail?: string | null;
  gasStation: boolean;
  department: "fuel" | "gas" | "both";
  createdAt?: Date;
  updatedAt?: Date;
}

const StaffSchema = new Schema<IStaff>(
  {
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, default: "" },
    address: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    zipCode: { type: String, default: "" },
    emergencyContact: { type: String, default: "" },
    image: { type: String, default: "" },
    role: {
      type: String,
      enum: ["manager", "supervisor", "accountant", "cashier", "attendant", "admin"],
      required: true,
    },
    station: { type: Schema.Types.ObjectId, ref: "FillingStation" },
    password: { type: String, required: true },
    // Free string so managers can assign station-defined custom shift types
    shiftType: {
      type: String,
      trim: true,
    },
    responsibility: [String],
    onDuty: {type: Boolean, required: true, default: false},
    addSaleTarget: { type: Boolean, required: true, default: false },
    payType: { type: String },
    amount: { type: Number, required: true, default: 0 },
    taxPercentage: { type: Number, default: 0 },
    bankDetails: {
      acctNo: { type: String, default: "" },
      acctName: { type: String, default: "" },
      bankName: { type: String, default: "" },
    },
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
    managedStations: [{ type: Schema.Types.ObjectId, ref: "FillingStation" }],
    isSuperManager: { type: Boolean, default: false },
    isOwner: { type: Boolean, default: false },
    isGroupAccountant: { type: Boolean, default: false },
    releasedEmail: { type: String, default: null },
    gasStation: { type: Boolean, default: false },
    department: { type: String, enum: ["fuel", "gas", "both"], default: "fuel" },
  },
  { timestamps: true }
);

StaffSchema.index({ station: 1, role: 1 });
StaffSchema.index({ email: 1 }, { unique: true });
StaffSchema.index({ station: 1, onDuty: 1 });

export default mongoose.model<IStaff>("Staff", StaffSchema);
