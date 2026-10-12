// Kessel as the default browser (defaults.rs): it registers itself as a
// browser -- in a test run under a key of the test's own, never the real
// one -- and a link Windows hands over with --single-argument opens in the
// Kessel already open (instance.rs).

import { execFileSync, spawn } from "node:child_process";
import { EXE } from "../lib/kessel.mjs";

const regValue = (key, name = null) => {
  const out = execFileSync("reg", ["query", `HKCU\\${key}`, ...(name ? ["/v", name] : ["/ve"])], { encoding: "utf8" });
  return out.split(/\r?\n/).find((l) => /REG_SZ/.test(l))?.split("REG_SZ")[1].trim() ?? null;
};

export const tests = [
  {
    name: "default browser: Kessel registers itself for web links and pages; a link Windows hands over opens in the Kessel already open",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      const root = await k.invoke("make_default_browser");
      try {
        assert(/^Software\\KesselTest\\\d+$/.test(root), `a test's own key: ${root}`);
        const command = regValue(`${root}\\Classes\\KesselHTML\\shell\\open\\command`);
        assert(command.includes("--profile-dir") && command.endsWith("--single-argument %1"), `opens links in this profile: ${command}`);
        assert.equal(regValue(`${root}\\Clients\\StartMenuInternet\\Kessel\\Capabilities\\URLAssociations`, "https"), "KesselHTML");
        assert.equal(regValue(`${root}\\RegisteredApplications`, "Kessel"), `${root}\\Clients\\StartMenuInternet\\Kessel\\Capabilities`);

        // As Windows would start it for a link.
        const link = `${site.origin}/page/FromWindows`;
        const code = await new Promise((resolve) => spawn(EXE, ["--profile-dir", k.profileDir, "--single-argument", link], { stdio: "ignore" }).on("exit", resolve));
        assert.equal(code, 0, "handed over, and gone");
        await waitFor(async () => (await k.tabs()).some((t) => t.url === link), { message: "the link, in a tab" });
      } finally {
        try {
          execFileSync("reg", ["delete", `HKCU\\${root}`, "/f"], { stdio: "ignore" });
          execFileSync("reg", ["delete", "HKCU\\Software\\KesselTest", "/f"], { stdio: "ignore" });
        } catch {}
      }
    },
  },
];
