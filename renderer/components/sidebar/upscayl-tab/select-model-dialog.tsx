"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Download, Maximize2, SwatchBookIcon, X, Zap } from "lucide-react";
import { MODELS, REFINED_MODELS } from "@common/models-list";
import { ELECTRON_COMMANDS } from "@common/electron-commands";
import { useAtom, useAtomValue } from "jotai";
import { selectedModelIdAtom } from "@/atoms/user-settings-atom";
import { customModelIdsAtom } from "@/atoms/models-list-atom";
import useTranslation from "@/components/hooks/use-translation";

type ModelStatus = {
  id: string;
  bytes: number;
  installed: boolean;
  bundled: boolean;
  license: string;
};

const mb = (b: number) => `${(b / 1e6).toFixed(b > 1e7 ? 0 : 1)} MB`;

const SelectModelDialog = () => {
  const t = useTranslation();
  const [selectedModelId, setSelectedModelId] = useAtom(selectedModelIdAtom);
  const customModelIds = useAtomValue(customModelIdsAtom);
  const [open, setOpen] = useState(false);
  const [zoomedModel, setZoomedModel] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, ModelStatus>>({});
  const [downloads, setDownloads] = useState<Record<string, number>>({});

  const refreshStatus = useCallback(async () => {
    const list: ModelStatus[] = await window.electron.invoke(ELECTRON_COMMANDS.REFINED_MODELS_STATUS);
    setStatus(Object.fromEntries((list ?? []).map((m) => [m.id, m])));
  }, []);

  useEffect(() => {
    refreshStatus();
    const off = window.electron.on(
      ELECTRON_COMMANDS.REFINED_MODEL_DOWNLOAD_PROGRESS,
      (_: any, p: { id: string; received: number; total: number }) =>
        setDownloads((d) => ({ ...d, [p.id]: p.total ? p.received / p.total : 0 })),
    ) as unknown as () => void;
    return () => off?.();
  }, [refreshStatus]);

  const download = async (id: string) => {
    setDownloads((d) => ({ ...d, [id]: 0 }));
    const res = await window.electron.invoke(ELECTRON_COMMANDS.REFINED_MODEL_DOWNLOAD, id);
    setDownloads((d) => {
      const n = { ...d };
      delete n[id];
      return n;
    });
    if (!res?.ok) alertError(res?.error);
    refreshStatus();
  };

  const alertError = (e?: string) => console.error("model download failed", e);

  const isInstalled = (id: string) => id === "refined-auto" || status[id]?.installed;

  const handleModelSelect = (model: string) => {
    if (!isInstalled(model)) return;
    setSelectedModelId(model);
    setOpen(false);
  };

  const label = (id: string) =>
    (REFINED_MODELS as readonly string[]).includes(id) || id in MODELS
      ? t(`APP.MODEL_SELECTION.MODELS.${id}.NAME` as any)
      : id;

  const comparison = (id: string) => (
    <div className="relative h-52 w-full overflow-hidden rounded-sm">
      <div className="flex h-full w-full">
        <img src={`public:///model-comparison/${id}/before.webp`} alt="Model Before" className="h-full w-1/2 object-cover" />
        <img src={`public:///model-comparison/${id}/after.webp`} alt="Model After" className="h-full w-1/2 object-cover" />
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="h-full w-px bg-white opacity-50"></div>
      </div>
      <div className="absolute bottom-2 left-2 rounded bg-black bg-opacity-50 px-1 text-xs text-white">
        {t("APP.MODEL_SELECTION.BEFORE")}
      </div>
      <div className="absolute bottom-2 right-2 rounded bg-black bg-opacity-50 px-1 text-xs text-white">
        {t("APP.MODEL_SELECTION.AFTER")}
      </div>
      <Button
        variant="secondary"
        size="icon"
        className="absolute right-2 top-2"
        onClick={(e) => {
          e.stopPropagation();
          setZoomedModel(id);
        }}
      >
        <Maximize2 className="h-4 w-4" />
        <span className="sr-only">{t("APP.MODEL_SELECTION.ZOOM")}</span>
      </Button>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) refreshStatus(); }}>
        <DialogTrigger asChild>
          <button className="btn btn-primary justify-start border-border">
            {(REFINED_MODELS as readonly string[]).includes(selectedModelId) ? (
              <Zap className="mr-2 h-5 w-5" />
            ) : (
              <SwatchBookIcon className="mr-2 h-5 w-5" />
            )}
            {label(selectedModelId)}
          </button>
        </DialogTrigger>
        <DialogContent className="z-50 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("APP.MODEL_SELECTION.DESCRIPTION")}</DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[600px] pr-4">
            <div className="flex flex-col gap-4">
              <div>
                <p className="font-semibold text-base-content">{t("APP.MODEL_SELECTION.REFINED_TITLE")}</p>
                <p className="text-xs text-base-content/70">{t("APP.MODEL_SELECTION.REFINED_SUBTITLE")}</p>
              </div>
              {REFINED_MODELS.map((id) => {
                const st = status[id];
                const installed = isInstalled(id);
                const progress = downloads[id];
                return (
                  <div
                    key={id}
                    role="button"
                    tabIndex={0}
                    className={`btn !h-auto !w-full !flex-col !items-start !rounded-sm !p-4 ${
                      selectedModelId === id ? "ring-2 ring-accent" : ""
                    } ${installed ? "" : "cursor-default opacity-90"}`}
                    onClick={() => handleModelSelect(id)}
                    onKeyDown={(e) => e.key === "Enter" && handleModelSelect(id)}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <p className="text-left font-semibold">{label(id)}</p>
                      {st && !installed && (
                        <span
                          className="btn btn-accent btn-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (progress === undefined) download(id);
                          }}
                        >
                          <Download className="h-3 w-3" />
                          {progress === undefined
                            ? `${t("APP.MODEL_SELECTION.DOWNLOAD")} ${mb(st.bytes)}`
                            : `${t("APP.MODEL_SELECTION.DOWNLOADING")} ${Math.round(progress * 100)}%`}
                        </span>
                      )}
                    </div>
                    <p className="mb-2 text-left font-normal leading-normal text-base-content/70">
                      {t(`APP.MODEL_SELECTION.MODELS.${id}.DESCRIPTION` as any)}
                      {st?.license && (
                        <span className="ml-1 text-xs text-base-content/50">· {st.license}</span>
                      )}
                    </p>
                    {comparison(id)}
                  </div>
                );
              })}

              <p className="font-semibold text-base-content">{t("APP.MODEL_SELECTION.CLASSIC_TITLE")}</p>
              {Object.keys(MODELS).map((modelId) => (
                <button
                  key={modelId}
                  className={`btn !h-auto !w-full !flex-col !items-start !rounded-sm !p-4 ${
                    selectedModelId === modelId ? "ring-2 ring-accent" : ""
                  }`}
                  onClick={() => handleModelSelect(modelId)}
                >
                  <p className="font-semibold">{t(`APP.MODEL_SELECTION.MODELS.${modelId}.NAME` as any)}</p>
                  <p className="mb-2 text-left font-normal leading-normal text-base-content/70">
                    {t(`APP.MODEL_SELECTION.MODELS.${modelId}.DESCRIPTION` as any)}
                  </p>
                  {comparison(modelId)}
                </button>
              ))}

              {customModelIds.length > 0 && (
                <p className="font-semibold text-base-content">
                  {t("APP.MODEL_SELECTION.IMPORTED_CUSTOM_MODELS")}
                </p>
              )}
              {customModelIds.map((customModel) => (
                <button
                  key={customModel}
                  className="btn h-auto w-full flex-col items-start p-4"
                  onClick={() => {
                    setSelectedModelId(customModel);
                    setOpen(false);
                  }}
                >
                  {customModel}
                </button>
              ))}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      <Dialog open={!!zoomedModel} onOpenChange={(o) => !o && setZoomedModel(null)}>
        <DialogContent className="h-screen w-screen max-w-full p-0" hideCloseButton>
          <div className="relative flex h-full w-full items-center justify-center bg-black">
            <div className="flex h-full w-full">
              <div className="relative h-full w-1/2">
                <img
                  src={`public:///model-comparison/${zoomedModel}/before.webp`}
                  alt="Zoomed in Image - Before"
                  className="h-full w-full object-contain"
                />
                <div className="absolute bottom-4 left-4 rounded bg-black bg-opacity-50 px-2 py-1 text-sm text-white">
                  {t("APP.MODEL_SELECTION.BEFORE")}
                </div>
              </div>
              <div className="relative h-full w-1/2">
                <img
                  src={`public:///model-comparison/${zoomedModel}/after.webp`}
                  alt="Zoomed in Image - After"
                  className="h-full w-full object-contain"
                />
                <div className="absolute bottom-4 right-4 rounded bg-black bg-opacity-50 px-2 py-1 text-sm text-white">
                  {t("APP.MODEL_SELECTION.AFTER")}
                </div>
              </div>
            </div>
            <button
              className="btn btn-circle btn-secondary absolute right-4 top-4"
              onClick={() => setZoomedModel(null)}
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SelectModelDialog;
