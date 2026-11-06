import { loadConfig } from "../config.js";
import { createPool } from "../db/database.js";
import { createAuth } from "./auth.js";

const config = loadConfig();

export const auth = createAuth(createPool(config.database), config);
