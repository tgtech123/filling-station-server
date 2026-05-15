import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import { listAssets, createAsset, updateAsset, deleteAsset } from "../controllers/fixedAsset.controller";

const router = Router();

router.use(requireAuth);

router.get("/", checkRole("accountant", "manager"), listAssets);
router.post("/", checkRole("accountant"), createAsset);
router.put("/:id", checkRole("accountant"), updateAsset);
router.delete("/:id", checkRole("accountant"), deleteAsset);

export default router;
