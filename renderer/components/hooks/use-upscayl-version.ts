import { useState, useEffect } from "react";

const useUpscaylVersion = () => {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    window.electron
      .getAppVersion()
      .then((v) => setVersion((v ?? "").split(" ")[0] || null))
      .catch(() => setVersion(null));
  }, []);

  return version;
};

export default useUpscaylVersion;
