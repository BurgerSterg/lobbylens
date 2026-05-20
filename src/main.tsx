import "./index.css";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyDocumentDarkClass, readStoredDarkMode } from "./theme";

applyDocumentDarkClass(readStoredDarkMode());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
