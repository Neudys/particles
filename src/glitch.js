const el = document.querySelector(".glitch-natural");

let x = 0;
let y = 0;

function jitter() {
  // rango MUY pequeño para que no maree
  const targetX = (Math.random() - 0.5) * 10; // -1px a 1px
  const targetY = (Math.random() - 0.5) * 5; // -0.3px a 0.3px

  // interpolación suave (no saltos)
  x += (targetX - x) * 0.08;
  y += (targetY - y) * 0.08;

  el.style.transform = `translate(${x}px, ${y}px)`;

  requestAnimationFrame(jitter);
}

jitter();
