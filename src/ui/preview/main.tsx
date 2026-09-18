import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Gallery, initialTheme } from "./gallery";
import "@/styles/index.css";
import "./preview.css";

const root = document.getElementById("root");
if (!root) throw new Error("The design preview root is missing.");
document.documentElement.dataset.theme = initialTheme();
createRoot(root).render(<StrictMode><Gallery /></StrictMode>);
