import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import App from "./App";
import { ToastProvider } from "./components/Toast";
import { AuthProvider } from "./lib/auth";
import { NeulozenoProvider } from "./lib/neulozeno";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <NeulozenoProvider>
            <App />
          </NeulozenoProvider>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
