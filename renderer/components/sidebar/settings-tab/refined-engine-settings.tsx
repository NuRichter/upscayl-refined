import { useAtom } from "jotai";
import { useEffect, useState } from "react";
import {
  refinedBackendAtom,
  refinedChromaLockAtom,
  refinedKeepWarmAtom,
} from "@/atoms/user-settings-atom";
import { ELECTRON_COMMANDS } from "@common/electron-commands";
import useTranslation from "@/components/hooks/use-translation";

export default function RefinedEngineSettings() {
  const t = useTranslation();
  const [chromaLock, setChromaLock] = useAtom(refinedChromaLockAtom);
  const [backend, setBackend] = useAtom(refinedBackendAtom);
  const [keepWarm, setKeepWarm] = useAtom(refinedKeepWarmAtom);

  const [uiGpu, setUiGpu] = useState<boolean | null>(null);

  useEffect(() => {
    window.electron.send(ELECTRON_COMMANDS.REFINED_ENGINE_CONFIG, { keepWarmSec: keepWarm });
  }, [keepWarm]);

  useEffect(() => {
    window.electron.invoke(ELECTRON_COMMANDS.APP_PREFS).then((p) => setUiGpu(!!p?.uiHardwareAcceleration));
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">{t("SETTINGS.REFINED.TITLE")}</p>

      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium">{t("SETTINGS.REFINED.COLOR_LOCK_TITLE")}</p>
        <p className="text-xs text-base-content/80">{t("SETTINGS.REFINED.COLOR_LOCK_DESCRIPTION")}</p>
        <input
          type="checkbox"
          className="toggle"
          checked={chromaLock}
          onChange={() => setChromaLock(!chromaLock)}
        />
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium">{t("SETTINGS.REFINED.BACKEND_TITLE")}</p>
        <p className="text-xs text-base-content/80">{t("SETTINGS.REFINED.BACKEND_DESCRIPTION")}</p>
        <div className="flex flex-wrap gap-1">
          {(["auto", "dml", "webgpu", "cpu"] as const).map((b) => (
            <button
              key={b}
              className={`btn btn-xs ${backend === b ? "btn-accent" : "btn-primary"}`}
              onClick={() => setBackend(b)}
            >
              {b === "auto" ? "Auto" : b === "dml" ? "DirectML" : b === "webgpu" ? "WebGPU" : "CPU"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium">{t("SETTINGS.REFINED.KEEP_WARM_TITLE")}</p>
        <p className="text-xs text-base-content/80">{t("SETTINGS.REFINED.KEEP_WARM_DESCRIPTION")}</p>
        <input
          type="number"
          min={5}
          max={600}
          value={keepWarm}
          onChange={(e) => {
            const v = parseInt(e.currentTarget.value, 10);
            if (!Number.isNaN(v)) setKeepWarm(Math.max(5, Math.min(600, v)));
          }}
          className="input input-primary input-sm w-28"
        />
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium">{t("SETTINGS.REFINED.UI_GPU_TITLE")}</p>
        <p className="text-xs text-base-content/80">{t("SETTINGS.REFINED.UI_GPU_DESCRIPTION")}</p>
        <input
          type="checkbox"
          className="toggle"
          checked={!!uiGpu}
          disabled={uiGpu === null}
          onChange={async () => {
            const p = await window.electron.invoke(ELECTRON_COMMANDS.APP_PREFS, {
              uiHardwareAcceleration: !uiGpu,
            });
            setUiGpu(!!p?.uiHardwareAcceleration);
          }}
        />
      </div>
    </div>
  );
}
