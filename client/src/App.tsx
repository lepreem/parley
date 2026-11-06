import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./hooks/auth/useAuth";
import { RequireAuth } from "./components/auth/RequireAuth";
import { LandingPage } from "./components/auth/LandingPage";
import { LoadingScreen } from "./components/ui/LoadingScreen";
import { Section } from "./components/app/Section";
import {
  canReachLocalServer,
  cloudServer,
  localServer,
  servedByLocalServer,
} from "./config";
import { ChatView } from "./components/chat/ChatView";
import { DownloadPage } from "./components/auth/DownloadPage";

/**
 * Landing route: send authenticated users straight to the app. A page the
 * local server served can't reach the cloud, so it opens this computer's
 * section instead.
 */
function LandingRoute() {
  const { user, loading } = useAuth();
  if (servedByLocalServer) return <Navigate to="/local" replace />;
  if (loading) return <LoadingScreen />;
  if (user) return <Navigate to="/chat" replace />;
  return <LandingPage />;
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingRoute />} />
      <Route element={<RequireAuth />}>
        <Route element={<Section server={cloudServer} />}>
          <Route path="/chat/:conversationId?" element={<ChatView />} />
        </Route>
      </Route>
      <Route path="/download" element={<DownloadPage />} />
      {canReachLocalServer ? (
        <Route element={<Section server={localServer} />}>
          <Route path="/local/:conversationId?" element={<ChatView />} />
        </Route>
      ) : (
        <Route
          path="/local/:conversationId?"
          element={<Navigate to="/download" replace />}
        />
      )}
      {/* Where the upload, history and job pages used to live. */}
      <Route path="/app" element={<Navigate to="/chat" replace />} />
      <Route path="/history" element={<Navigate to="/chat" replace />} />
      <Route
        path="/jobs/:audioUploadId"
        element={<Navigate to="/chat" replace />}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
