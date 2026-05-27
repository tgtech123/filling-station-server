import { Types } from "mongoose";
import Staff from "../models/staff.model";
import Shift from "../models/shift.model";
import Activity from "../models/activity.model";
import ActivityLog from "../models/activityLog.model";
import Tank from "../models/tanks.model";
import InviteToken from "../models/inviteToken.model";
import Notification from "../models/notification.model";
import Pump from "../models/pump.model";
import Expense from "../models/expense.model";
import SalaryDraft from "../models/salary.model";
import StationStatus from "../models/stationStatus.model";
import CashReconciliation from "../models/cashReconciliation.model";
import FinancialEntry from "../models/financialEntry.model";
import Report from "../models/report.model";
import SalesTarget from "../models/salesTarget.model";
import FixedAsset from "../models/fixedAsset.model";
import DipReading from "../models/dipReading.model";
import Delivery from "../models/delivery.model";
import CommissionStructure from "../models/commissionStructure.model";
import CommissionPayment from "../models/commissionPayment.model";
import BonusStructure from "../models/bonusStructure.model";
import Lubricant from "../models/lubricant.model";
import LubricantTransaction from "../models/lubricant-transaction.model";
import LubricantPurchase from "../models/lubricant-purchase.model";
import LubricantProcurement from "../models/lubricantProcurement.model";
import GasShift from "../models/gasShift.model";
import GasSale from "../models/gasSale.model";
import GasTank from "../models/gasTank.model";
import GasPump from "../models/gasPump.model";
import GasOrder from "../models/gasOrder.model";
import GasInventory from "../models/gasInventory.model";
import GasReconciliation from "../models/gasReconciliation.model";
import GasProcurement from "../models/gasProcurement.model";
import GasCustomer from "../models/gasCustomer.model";
import GasPricing from "../models/gasPricing.model";
import GasCylinderSize from "../models/gasCylinderSize.model";
import GasLoyaltyTransaction from "../models/gasLoyaltyTransaction.model";
import Supplier from "../models/supplier.model";

export async function cascadeDeleteBranch(branchId: string): Promise<void> {
  const id = new Types.ObjectId(branchId);

  await Promise.all([
    // Staff & access
    Staff.deleteMany({ station: branchId }),
    InviteToken.deleteMany({ station: branchId }),
    // Core operations
    Shift.deleteMany({ fillingStation: id }),
    Activity.deleteMany({ fillingStation: id }),
    ActivityLog.deleteMany({ fillingStation: id }),
    Tank.deleteMany({ fillingStation: id }),
    Pump.deleteMany({ fillingStation: id }),
    DipReading.deleteMany({ fillingStation: id }),
    Delivery.deleteMany({ fillingStation: id }),
    // Notifications
    Notification.deleteMany({ fillingStation: id }),
    // Financial
    Expense.deleteMany({ fillingStation: id }),
    SalaryDraft.deleteMany({ fillingStation: id }),
    CashReconciliation.deleteMany({ fillingStation: id }),
    FinancialEntry.deleteMany({ fillingStation: id }),
    Report.deleteMany({ fillingStation: id }),
    SalesTarget.deleteMany({ fillingStation: id }),
    FixedAsset.deleteMany({ fillingStation: id }),
    CommissionStructure.deleteMany({ fillingStation: id }),
    CommissionPayment.deleteMany({ fillingStation: id }),
    BonusStructure.deleteMany({ fillingStation: id }),
    StationStatus.deleteMany({ fillingStation: id }),
    // Lubricant
    Lubricant.deleteMany({ fillingStation: id }),
    LubricantTransaction.deleteMany({ fillingStation: id }),
    LubricantPurchase.deleteMany({ fillingStation: id }),
    LubricantProcurement.deleteMany({ fillingStation: id }),
    // Gas
    GasShift.deleteMany({ fillingStation: id }),
    GasSale.deleteMany({ fillingStation: id }),
    GasTank.deleteMany({ fillingStation: id }),
    GasPump.deleteMany({ fillingStation: id }),
    GasOrder.deleteMany({ fillingStation: id }),
    GasInventory.deleteMany({ fillingStation: id }),
    GasReconciliation.deleteMany({ fillingStation: id }),
    GasProcurement.deleteMany({ fillingStation: id }),
    GasCustomer.deleteMany({ fillingStation: id }),
    GasPricing.deleteMany({ fillingStation: id }),
    GasCylinderSize.deleteMany({ fillingStation: id }),
    GasLoyaltyTransaction.deleteMany({ fillingStation: id }),
    Supplier.deleteMany({ fillingStation: id }),
  ]);
}
