import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import VyberJmena from "./pages/VyberJmena";
import Nastaveni from "./pages/Nastaveni";
import Dashboard from "./pages/Dashboard";
import Displays from "./pages/Displays";
import DisplayDetail from "./pages/DisplayDetail";
import Prales from "./pages/Prales";
import Videomapping from "./pages/Videomapping";
import Diry from "./pages/Diry";
import Tablet from "./pages/Tablet";
import Audit from "./pages/Audit";
import Analytika from "./pages/Analytika";

function Protected({ children }: { children: React.ReactNode }) {
  const { username, jmeno, ready } = useAuth();
  if (!ready) {
    return (
      <div className="min-h-screen grid place-items-center text-fg-dim text-sm">Načítám…</div>
    );
  }
  if (!username) return <Navigate to="/login" replace />;
  // Přihlášený, ale ještě si nevybral jméno. Schválně BEZ přesměrování:
  // adresa zůstane, takže po výběru pokračuje tam, kam mířil.
  if (!jmeno) return <VyberJmena />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      {/* Náhled tabletu je veřejný (to vidí návštěvník u displeje). */}
      <Route path="/tablet/:id" element={<Tablet />} />

      <Route
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/displeje" element={<Displays />} />
        <Route path="/displeje/:id" element={<DisplayDetail />} />
        <Route path="/prales" element={<Prales />} />
        <Route path="/videomapping" element={<Videomapping />} />
        <Route path="/diry" element={<Diry />} />
        <Route path="/analytika" element={<Analytika />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="/nastaveni" element={<Nastaveni />} />
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
