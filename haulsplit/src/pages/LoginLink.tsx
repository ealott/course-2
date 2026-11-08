import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Me } from "../../shared/api";
import { api } from "../api";
import { useSession } from "../session";
import { ErrorState, Loading, TopBar, errorMessage, useToast } from "../ui";

export function LoginLink() {
  const { token = "" } = useParams();
  const { setMe } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const [error, setError] = useState("");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // links are one-time: don't spend it twice in StrictMode
    started.current = true;
    api<{ me: Me }>("POST", "/auth/link", { token })
      .then(({ me }) => {
        setMe(me);
        toast(`Logged in as ${me.name}`);
        navigate(me.hasPassword ? "/" : "/me?welcome=1", { replace: true });
      })
      .catch((err) => setError(errorMessage(err)));
  }, [token, setMe, navigate, toast]);

  return (
    <>
      <TopBar />
      {error ? <ErrorState message={error} /> : <Loading />}
    </>
  );
}
