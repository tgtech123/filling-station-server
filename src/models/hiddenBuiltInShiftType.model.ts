import mongoose, { Document, Schema, Model } from "mongoose";

/**
 * Records that a station has hidden one of the BUILT_IN_SHIFT_TYPES from its
 * dropdowns. Built-ins are never stored as rows themselves (they ship in code),
 * so hiding is expressed as a per-station suppression list keyed by the built-in
 * `name`. Re-enabling simply deletes the row. History is never affected because
 * the built-in name still resolves — it's only omitted from selection lists.
 */
export interface IHiddenBuiltInShiftType extends Document {
  fillingStation: mongoose.Types.ObjectId;
  name: string; // one of BUILT_IN_SHIFT_TYPES[].name
  hiddenBy: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const schema = new Schema<IHiddenBuiltInShiftType>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    name: { type: String, required: true, trim: true },
    hiddenBy: { type: Schema.Types.ObjectId, ref: "Staff", required: true },
  },
  { timestamps: true }
);

schema.index({ fillingStation: 1, name: 1 }, { unique: true });

const HiddenBuiltInShiftType: Model<IHiddenBuiltInShiftType> =
  mongoose.model<IHiddenBuiltInShiftType>("HiddenBuiltInShiftType", schema);

export default HiddenBuiltInShiftType;
