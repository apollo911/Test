// Packages src/ as a Supabase Edge Function (Deno) in supabase/functions/trello-mcp.
// Deno needs explicit .ts extensions and npm: specifiers, so imports are rewritten.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = (name) => pkg.dependencies[name].replace(/^[\^~]/, "");
const out = "supabase/functions/trello-mcp";
const files = ["http.ts", "server.ts", "tools.ts", "trello-client.ts", "format.ts"];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of files) {
  const source = readFileSync(`src/${file}`, "utf8").replace(/from "(\.\/[\w-]+)\.js"/g, 'from "$1.ts"');
  writeFileSync(`${out}/${file}`, source);
}
writeFileSync(
  `${out}/index.ts`,
  `import { handleMcpRequest } from "./http.ts";\n\nDeno.serve(handleMcpRequest);\n`,
);
writeFileSync(
  `${out}/deno.json`,
  JSON.stringify(
    {
      imports: {
        "@modelcontextprotocol/sdk/": `npm:/@modelcontextprotocol/sdk@${version("@modelcontextprotocol/sdk")}/`,
        zod: `npm:zod@${version("zod")}`,
      },
    },
    null,
    2,
  ) + "\n",
);
console.log(`Edge function written to ${out}`);
