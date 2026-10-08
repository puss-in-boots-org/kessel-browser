// A window moved: its pages know where they are on screen now -- one moved in
// from another window too (browser_windows.rs parent_moved). Otherwise what
// a page places by screen position (the autofill list, a <select>'s list)
// lands where the window used to be.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "movewindows.ps1");
const moveAll = (pid, dx, dy) => Number(execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-ProcessId", String(pid), "-Dx", String(dx), "-Dy", String(dy)], { encoding: "utf8" }).trim());

export const tests = [
  {
    name: "a page moved into another window knows where it is on screen when that window moves",
    async run({ launch, site, assert, waitFor }) {
      const k = await launch();
      await k.createTab(`${site.origin}/page/B`);
      await waitFor(async () => (await k.tabs()).length === 2, { message: "two tabs" });
      const b = (await k.tabs()).find((t) => t.title === "B");
      await k.invoke("move_tab_to_new_window", { id: b.id });
      await waitFor(async () => (await k.windows()).length === 2, { message: "a second window" });
      const page = await k.page((t) => t.url.includes("/page/B"));
      const where = () => page.evaluate(`[screenX, screenY]`);
      await new Promise((r) => setTimeout(r, 800));
      const before = await where();
      assert(moveAll(k.child.pid, -300, 200) >= 2, "the windows moved");
      await waitFor(async () => {
        const now = await where();
        return now[0] === before[0] - 300 && now[1] === before[1] + 200;
      }, { message: `the page's screen position follows (was ${before})` }).catch(async (e) => {
        const toolbars = await Promise.all((await k.toolbars()).map(async (t) => `${t.label} ${await t.page.evaluate(`[screenX, screenY]`)}`));
        throw new Error(`${e.message}; now ${await where()}; toolbars ${toolbars.join(" / ")}`);
      });
    },
  },
];
