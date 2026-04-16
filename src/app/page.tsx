import { SCENARIOS } from "@/lib/scenarios";
import DecisionUI from "./decision-ui";

export default function Page() {
  return <DecisionUI scenarios={SCENARIOS} />;
}
