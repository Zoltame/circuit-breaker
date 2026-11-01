// Regenerates policies/schema.json from the zod schema (single source of truth).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { policyJsonSchema } from "../src/policy.ts";

const out = fileURLToPath(new URL("../../../policies/schema.json", import.meta.url));
writeFileSync(out, `${JSON.stringify(policyJsonSchema(), null, 2)}\n`);
console.log(`wrote ${out}`);
