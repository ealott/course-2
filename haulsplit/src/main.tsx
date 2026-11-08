import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Checkout } from "./pages/Checkout";
import { GroupPage } from "./pages/Group";
import { HaulPage } from "./pages/Haul";
import { Home } from "./pages/Home";
import { Join } from "./pages/Join";
import { LoginLink } from "./pages/LoginLink";
import { NewGroup } from "./pages/NewGroup";
import { NewHaul } from "./pages/NewHaul";
import { Profile } from "./pages/Profile";
import { ReceiptImport } from "./pages/ReceiptImport";
import { Welcome } from "./pages/Welcome";
import { RequireMe, SessionProvider, useSession } from "./session";
import { Loading, ToastProvider } from "./ui";
import "./styles.css";

function Root() {
  const { me, ready } = useSession();
  if (!ready) return <Loading />;
  return me ? <Home /> : <Navigate to="/welcome" replace />;
}

const authed = (el: ReactNode) => <RequireMe>{el}</RequireMe>;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <ToastProvider>
          <div className="app">
            <Routes>
              <Route path="/" element={<Root />} />
              <Route path="/welcome" element={<Welcome />} />
              <Route path="/join/:code" element={<Join />} />
              <Route path="/l/:token" element={<LoginLink />} />
              <Route path="/groups/new" element={authed(<NewGroup />)} />
              <Route path="/g/:id" element={authed(<GroupPage />)} />
              <Route path="/g/:id/new" element={authed(<NewHaul />)} />
              <Route path="/h/:id" element={authed(<HaulPage />)} />
              <Route path="/h/:id/import" element={authed(<ReceiptImport />)} />
              <Route path="/h/:id/pay" element={authed(<Checkout />)} />
              <Route path="/me" element={authed(<Profile />)} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </ToastProvider>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
