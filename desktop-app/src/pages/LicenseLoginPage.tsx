import { useState, type FormEvent } from "react";
import { ArrowRight, Eye, EyeOff, KeyRound } from "lucide-react";
import { WindowChrome } from "../components/ui";
import luxuryMark from "../assets/luxury-emblem.png";

type LicenseLoginPageProps = {
  onActivate: (licenseKey: string) => Promise<void>;
  notice?: string;
};

export function LicenseLoginPage({ onActivate, notice }: LicenseLoginPageProps) {
  const [licenseKey, setLicenseKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState("");
  const [activating, setActivating] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!licenseKey.trim()) {
      setError("Введите лицензионный ключ, чтобы продолжить.");
      return;
    }

    setError("");
    setActivating(true);
    try {
      await onActivate(licenseKey.trim());
    } catch (activationError) {
      setError(activationError instanceof Error ? activationError.message : "Не удалось проверить лицензию.");
    } finally {
      setActivating(false);
    }
  };

  return (
    <main className="license-screen">
      <WindowChrome />
      <div className="license-glow license-glow-one" />
      <div className="license-glow license-glow-two" />
      <div className="license-layout">
        <section className="license-intro">
          <div className="license-brand">
            <img src={luxuryMark} alt="" />
            <span>Luxury</span>
          </div>
          <div className="license-intro-copy">
            <span className="license-eyebrow"><i /> LUXURY WORKSPACE</span>
            <h1>Ваше рабочее пространство начинается здесь.</h1>
            <p>Введите лицензионный ключ, чтобы открыть приложение и продолжить работу.</p>
          </div>
          <span className="license-version">DESKTOP WORKSPACE <i /> SECURE ACCESS</span>
        </section>

        <section className="license-panel">
          <div className="license-panel-icon"><KeyRound size={19} /></div>
          <span className="license-panel-kicker">АКТИВАЦИЯ ДОСТУПА</span>
          <h2>Вход по ключу</h2>
          <p className="license-panel-copy">Укажите лицензионный ключ, чтобы войти в Luxury.</p>

          <form className="license-form" onSubmit={submit}>
            <label htmlFor="license-key">ЛИЦЕНЗИОННЫЙ КЛЮЧ</label>
            <div className={`license-input-wrap ${error ? "has-error" : ""}`}>
              <KeyRound size={16} aria-hidden="true" />
              <input
                id="license-key"
                type={showKey ? "text" : "password"}
                value={licenseKey}
                onChange={(event) => { setLicenseKey(event.target.value); setError(""); }}
                placeholder="Введите ключ лицензии"
                autoComplete="off"
                autoFocus
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "license-error" : undefined}
              />
              <button className="license-visibility" type="button" onClick={() => setShowKey((visible) => !visible)} aria-label={showKey ? "Скрыть ключ" : "Показать ключ"}>
                {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {(error || notice) && <span className="license-error" id="license-error">{error || notice}</span>}
            <button className="license-submit" type="submit" disabled={activating}>
              {activating ? "Подключаем доступ…" : "Продолжить"}
              {!activating && <ArrowRight size={17} />}
            </button>
          </form>

          <div className="license-help">Нет ключа? <a href="https://t.me/luxurymailer_bot" target="_blank" rel="noopener noreferrer">Свяжитесь с поддержкой Luxury</a></div>
        </section>
      </div>
    </main>
  );
}
