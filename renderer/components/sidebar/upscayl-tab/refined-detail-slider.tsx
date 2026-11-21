import { useAtom, useAtomValue } from "jotai";
import { refinedDetailAtom, selectedModelIdAtom } from "@/atoms/user-settings-atom";
import { DETAIL_MODELS } from "@common/models-list";
import useTranslation from "@/components/hooks/use-translation";

/** One slider for the network-interpolation mix of HEART/NERVE graphs. */
export default function RefinedDetailSlider() {
  const t = useTranslation();
  const model = useAtomValue(selectedModelIdAtom);
  const [detail, setDetail] = useAtom(refinedDetailAtom);
  if (!DETAIL_MODELS.includes(model)) return null;

  const auto = detail < 0;
  const value = auto ? 50 : Math.round(detail * 100);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <p
          className="cursor-help text-sm font-medium"
          data-tooltip-id="tooltip"
          data-tooltip-content={t("APP.DETAIL.DESCRIPTION")}
        >
          {t("APP.DETAIL.TITLE")}
          <span className="ml-2 text-xs text-base-content/60">{auto ? t("APP.DETAIL.AUTO") : `${value}%`}</span>
        </p>
        <label className="flex cursor-pointer items-center gap-1 text-xs">
          <input
            type="checkbox"
            className="checkbox checkbox-xs"
            checked={auto}
            onChange={(e) => setDetail(e.target.checked ? -1 : 0.5)}
          />
          {t("APP.DETAIL.AUTO")}
        </label>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        disabled={auto}
        className="range range-primary range-xs"
        onChange={(e) => setDetail(parseInt(e.target.value, 10) / 100)}
      />
      <div className="flex justify-between text-[10px] uppercase text-base-content/50">
        <span>{t("APP.DETAIL.FAITHFUL")}</span>
        <span>{t("APP.DETAIL.SHARP")}</span>
      </div>
    </div>
  );
}
