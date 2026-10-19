import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { getLocale } from "./lib/i18n";
import "./styles.css";

// The interface language is settled before the first render, so the first paint is already translated.
getLocale();

const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);
