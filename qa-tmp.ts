import "dotenv/config";
import { answerQuestion } from "./lib/explainer";
const ava = "cmw13oiwc0003zwqhnvwcbwex";
async function main() {
for (const q of ["Why was my October payout so much higher than September?", "My Pioneer deal is missing from this month"]) {
  const r = await answerQuestion(ava, q, "2026-11");
  console.log("Q:", q, "\n", r.category, r.model, "\n", r.answer, "\n");
}
}
main().then(() => process.exit(0));
