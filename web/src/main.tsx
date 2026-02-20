import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import { initAnalytics } from "./analytics.js";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";
import "./index.css";

initAnalytics();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>
);
