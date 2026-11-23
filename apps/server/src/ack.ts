/**
 * What the Capitán says on a call the moment he decides to act, built from what he is about to do: "Va, te apunto a
 * Bingo Lunático...", "Le mando tu mensaje a Ricardo...". It covers the seconds the tool and his answer take, and it
 * always fits the request, unlike a generic "déjame ver". Instant tools (remembering, preferences, links) get none.
 * Every line ends in "... " so the answer that follows doesn't run into it.
 */
import { type Person, type Store, prettyDate, shipDate } from "@crucero/db";

type Lang = "es" | "en";
type Input = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** "hoy", "mañana" or "el martes 29 de diciembre" (English: "today", "tomorrow", "Tuesday, December 29"). */
function day(date: string | undefined, now: Date, lang: Lang): string | undefined {
  if (!date) return undefined;
  const today = shipDate(now);
  const tomorrow = shipDate(new Date(now.getTime() + 86_400_000));
  if (date === today) return lang === "es" ? "de hoy" : "today's";
  if (date === tomorrow) return lang === "es" ? "de mañana" : "tomorrow's";
  return lang === "es" ? `del ${prettyDate(date, "es")}` : `${prettyDate(date, "en")}'s`;
}

export async function acknowledgment(store: Store, person: Person, tool: string, input: Input, now: Date): Promise<string | undefined> {
  const lang: Lang = person.language === "en" ? "en" : "es";
  const es = lang === "es";
  const title = async () => {
    const id = str(input.activity_id);
    return (id && (await store.getActivity(id))?.title) || (es ? "esa actividad" : "that one");
  };
  const someoneElse = str(input.person_name) && !/^(me|yo|mí|mi)$/i.test(str(input.person_name)!) ? str(input.person_name) : undefined;
  let line: string | undefined;
  switch (tool) {
    case "get_program": {
      const d = day(str(input.date), now, lang);
      line = es ? `Déjame revisar el programa${d ? ` ${d}` : ""}` : `Let me check ${d ?? "the"} program`;
      break;
    }
    case "get_my_day":
      line = someoneElse ? (es ? `Déjame revisar la agenda de ${someoneElse}` : `Let me check ${someoneElse}'s plan`) : es ? "Déjame revisar tu agenda" : "Let me check your plan";
      break;
    case "who_is_going":
      line = es ? `Déjame ver quién va a ${await title()}` : `Let me see who's going to ${await title()}`;
      break;
    case "signup": {
      const t = await title();
      const who = someoneElse;
      const status = str(input.status);
      line =
        status === "out"
          ? es ? `${who ? `Quito a ${who}` : "Te quito"} de ${t}` : `Taking ${who ?? "you"} off ${t}`
          : status === "maybe"
            ? es ? `${who ? `Pongo a ${who}` : "Te pongo"} como «tal vez» en ${t}` : `Putting ${who ?? "you"} down as a maybe for ${t}`
            : es ? `Va, ${who ? `apunto a ${who}` : "te apunto"} a ${t}` : `Signing ${who ?? "you"} up for ${t}`;
      break;
    }
    case "create_activity":
      line = es ? `Anoto ${str(input.title) ?? "tu actividad"} en el programa` : `Putting ${str(input.title) ?? "your activity"} on the program`;
      break;
    case "update_activity":
      line = es ? `Cambio los detalles de ${await title()}` : `Updating ${await title()}`;
      break;
    case "cancel_activity":
      line = es ? `Cancelo ${await title()}` : `Cancelling ${await title()}`;
      break;
    case "send_message": {
      const to = str(input.to);
      const all = !to || /^(everyone|todos)$/i.test(to);
      line = all ? (es ? "Lo anuncio a todo el barco" : "Announcing it to the whole ship") : es ? `Le mando tu mensaje a ${to}` : `Sending your message to ${to}`;
      break;
    }
    case "generate_flyer":
      line = es ? `Mando el flyer de ${await title()} a la imprenta` : `Sending ${await title()}'s flyer to the print shop`;
      break;
    case "get_weather": {
      const d = day(str(input.date), now, lang);
      line = es ? `Déjame ver el pronóstico${d ? ` ${d}` : ""}` : `Let me check ${d ?? "the"} forecast`;
      break;
    }
    case "suggest_for_empty_slots":
      line = es ? "Déjame buscarte algo" : "Let me find you something";
      break;
    case "mark_attendance":
      line = es ? `Anoto quién vino a ${await title()}` : `Noting who came to ${await title()}`;
      break;
    case "confirm_event":
      line = es ? `Anoto que sí se hizo ${await title()}` : `Noting that ${await title()} happened`;
      break;
    case "my_conchitas":
      line = es ? "Reviso tu cofre" : "Checking your treasure chest";
      break;
    case "list_passengers":
    case "admin_manifest":
      line = es ? "Reviso el manifiesto" : "Checking the manifest";
      break;
  }
  return line ? `${line}... ` : undefined;
}
