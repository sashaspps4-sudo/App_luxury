import { useEffect, useRef } from "react";

const INTERACTIVE_SELECTOR = "button, a, input, select, textarea, [role='button']";
const PARTICLE_COUNT = 10;

export function GlowCursor() {
  const cursorRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!window.matchMedia("(pointer: fine)").matches || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const cursor = cursorRef.current;
    const trail = trailRef.current;
    if (!cursor || !trail) return;

    const particles = Array.from(trail.querySelectorAll<HTMLElement>(".cursor-particle"));

    let frame = 0;
    let pointerX = -40;
    let pointerY = -40;
    let lastParticleX = -40;
    let lastParticleY = -40;
    let lastParticleAt = 0;
    let particleIndex = 0;

    const spawnParticle = (x: number, y: number, now: number) => {
      const distance = Math.hypot(x - lastParticleX, y - lastParticleY);
      if (distance < 9 || now - lastParticleAt < 30) return;

      const particle = particles[particleIndex];
      particleIndex = (particleIndex + 1) % particles.length;
      lastParticleX = x;
      lastParticleY = y;
      lastParticleAt = now;

      const size = 2 + Math.random() * 2.3;
      const startX = x - size / 2 + (Math.random() - 0.5) * 7;
      const startY = y - size / 2 + (Math.random() - 0.5) * 7;
      const driftX = (Math.random() - 0.5) * 10;
      const driftY = 5 + Math.random() * 10;

      particle.style.width = `${size}px`;
      particle.style.height = `${size}px`;
      particle.getAnimations().forEach((animation) => animation.cancel());
      particle.animate(
        [
          { opacity: 0.22, transform: `translate3d(${startX}px, ${startY}px, 0) scale(1)` },
          { opacity: 0, transform: `translate3d(${startX + driftX}px, ${startY + driftY}px, 0) scale(.25)` },
        ],
        { duration: 460 + Math.random() * 180, easing: "cubic-bezier(.18,.68,.28,1)", fill: "forwards" },
      );
    };

    const render = () => {
      frame = 0;
      cursor.style.transform = `translate3d(${pointerX - 7}px, ${pointerY - 7}px, 0)`;
    };

    const scheduleRender = (event: PointerEvent) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      cursor.classList.add("is-visible");
      const target = event.target instanceof Element ? event.target : null;
      cursor.classList.toggle("is-interactive", Boolean(target?.closest(INTERACTIVE_SELECTOR)));
      spawnParticle(pointerX, pointerY, event.timeStamp);
      if (!frame) frame = window.requestAnimationFrame(render);
    };

    const hide = () => cursor.classList.remove("is-visible");
    const press = () => cursor.classList.add("is-pressed");
    const release = () => cursor.classList.remove("is-pressed");

    document.documentElement.classList.add("cursor-enabled");
    window.addEventListener("pointermove", scheduleRender, { passive: true });
    window.addEventListener("pointerdown", press, { passive: true });
    window.addEventListener("pointerup", release, { passive: true });
    document.documentElement.addEventListener("mouseleave", hide);
    window.addEventListener("blur", hide);

    return () => {
      document.documentElement.classList.remove("cursor-enabled");
      window.removeEventListener("pointermove", scheduleRender);
      window.removeEventListener("pointerdown", press);
      window.removeEventListener("pointerup", release);
      document.documentElement.removeEventListener("mouseleave", hide);
      window.removeEventListener("blur", hide);
      if (frame) window.cancelAnimationFrame(frame);
      particles.forEach((particle) => particle.getAnimations().forEach((animation) => animation.cancel()));
    };
  }, []);

  return <>
    <div ref={trailRef} className="cursor-particle-layer" aria-hidden="true">
      {Array.from({ length: PARTICLE_COUNT }, (_, index) => <span className="cursor-particle" key={index} />)}
    </div>
    <div ref={cursorRef} className="glow-cursor" aria-hidden="true" />
  </>;
}
