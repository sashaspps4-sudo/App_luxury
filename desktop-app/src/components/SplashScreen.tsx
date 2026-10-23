import { useEffect, useState } from "react";
import luxuryMark from "../assets/luxury-emblem.png";

export function SplashScreen() {
  const [phase, setPhase] = useState<"visible" | "leaving" | "hidden">("visible");

  useEffect(() => {
    const leaveTimer = window.setTimeout(() => setPhase("leaving"), 1650);
    const hideTimer = window.setTimeout(() => setPhase("hidden"), 2050);
    return () => {
      window.clearTimeout(leaveTimer);
      window.clearTimeout(hideTimer);
    };
  }, []);

  if (phase === "hidden") return null;

  return (
    <div className={`splash-screen ${phase === "leaving" ? "is-leaving" : ""}`} aria-label="Luxury загружается">
      <div className="splash-light splash-light-one" />
      <div className="splash-light splash-light-two" />
      <div className="splash-content">
        <img className="splash-logo" src={luxuryMark} alt="" />
        <div className="splash-name">Luxury</div>
        <div className="splash-loader" aria-hidden="true"><span /></div>
        <p>ЗАГРУЗКА ПРИЛОЖЕНИЯ</p>
      </div>
    </div>
  );
}
