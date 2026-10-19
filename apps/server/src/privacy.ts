/**
 * Public privacy policy, served at /privacy (Meta requires a URL before an app can be published).
 * Bilingual, plain HTML, no tracking. The contact line comes from PRIVACY_CONTACT when set.
 */
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function privacyPolicyHtml(contact?: string): string {
  const es = contact ? esc(contact) : "el familiar que te invitó al crucero";
  const en = contact ? esc(contact) : "the family member who invited you";
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aviso de privacidad · Crucero Luna 2026</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.55 system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 1.6rem; }
  hr { margin: 2.5rem 0; } small { opacity: .7; }
</style>
</head>
<body>
<h1>Aviso de privacidad · Crucero Luna 2026</h1>
<p><small>Vigente desde el 19 de octubre de 2026</small></p>
<p>El <strong>Capitán Lunático</strong> es un asistente de WhatsApp para un viaje familiar privado de La Familia Luna
(Acapulco, 26 de diciembre de 2026 al 2 de enero de 2027). Solo lo usan los invitados al viaje. No es un servicio comercial.</p>

<h2>Qué datos usamos</h2>
<ul>
  <li>Tu número de WhatsApp y el nombre de tu perfil.</li>
  <li>Los mensajes que le envías al Capitán y sus respuestas.</li>
  <li>Lo que tú decidas compartir: cómo quieres que te llamen, idioma, horarios de silencio, gustos o necesidades (por ejemplo, una alergia) para planear las actividades.</li>
  <li>Las actividades que organizas y a las que te apuntas.</li>
</ul>

<h2>Para qué</h2>
<p>Solo para organizar el viaje: responderte, armar el programa diario, mandarte recordatorios y avisos de las actividades.
No vendemos tus datos, no los usamos para publicidad y no los compartimos con nadie fuera del viaje.</p>

<h2>Quién más los procesa</h2>
<ul>
  <li><strong>Meta (WhatsApp)</strong>, que entrega los mensajes.</li>
  <li><strong>Anthropic (Claude)</strong>, el modelo de IA que escribe las respuestas del Capitán. Recibe tus mensajes y el contexto del viaje para contestar.</li>
  <li><strong>Fly.io</strong> (y, más adelante, <strong>Supabase</strong>), donde se aloja el servidor y la información del viaje.</li>
</ul>

<h2>Cuánto tiempo los guardamos</h2>
<p>Hasta que termine el viaje. Borramos todos los datos a más tardar el 31 de enero de 2027.</p>

<h2>Tus opciones</h2>
<ul>
  <li>Escríbele al Capitán <em>«ya no me mandes nada»</em> para dejar de recibir mensajes que tú no pediste.</li>
  <li>Para ver, corregir o borrar tus datos antes de esa fecha, contacta a ${es}. Lo hacemos en un máximo de 30 días.</li>
</ul>

<hr>

<h1 lang="en">Privacy policy · Crucero Luna 2026</h1>
<div lang="en">
<p><small>Effective October 19, 2026</small></p>
<p><strong>Capitán Lunático</strong> is a WhatsApp assistant for La Familia Luna's private family trip
(Acapulco, December 26, 2026 to January 2, 2027). Only invited guests use it. It is not a commercial service.</p>

<h2>What we use</h2>
<ul>
  <li>Your WhatsApp number and profile name.</li>
  <li>The messages you send the Capitán and its replies.</li>
  <li>What you choose to share: what to call you, language, quiet hours, likes or needs (such as an allergy) for planning activities.</li>
  <li>The activities you host and sign up for.</li>
</ul>

<h2>Why</h2>
<p>Only to run the trip: replying to you, building the daily program, and sending reminders and activity notices.
We do not sell your data, use it for advertising, or share it with anyone outside the trip.</p>

<h2>Who else processes it</h2>
<ul>
  <li><strong>Meta (WhatsApp)</strong>, which delivers the messages.</li>
  <li><strong>Anthropic (Claude)</strong>, the AI model that writes the Capitán's replies. It receives your messages and the trip context to answer.</li>
  <li><strong>Fly.io</strong> (and later <strong>Supabase</strong>), which host the server and the trip data.</li>
</ul>

<h2>How long we keep it</h2>
<p>Until the trip is over. We delete all data by January 31, 2027 at the latest.</p>

<h2>Your choices</h2>
<ul>
  <li>Tell the Capitán <em>"stop messaging me"</em> to stop messages you did not ask for.</li>
  <li>To see, correct or delete your data sooner, contact ${en}. We act within 30 days.</li>
</ul>
</div>
</body>
</html>`;
}
