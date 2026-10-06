// Resolves the "@/" path alias for plain Node so the verification scripts can import the real service
// modules outside Next.js. Register it with:  node --import ./scripts/register.mjs <script>
// Verification always exercises the application's own code; nothing is re-implemented or stubbed.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./alias-loader.mjs", pathToFileURL(import.meta.filename));
