import { useEffect } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { ask } from "@tauri-apps/plugin-dialog";

export function useUpdater() {
  useEffect(() => {
    async function checkForUpdates() {
      try {
        const update = await check();
        if (!update) return;
        const yes = await ask(
          `Version ${update.version} is available. Install now?`,
          { title: "BurgerLens Update", kind: "info" },
        );
        if (yes) {
          await update.downloadAndInstall();
        }
      } catch (e) {
        console.error("Updater error:", e);
      }
    }
    void checkForUpdates();
  }, []);
}
