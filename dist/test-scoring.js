import { extractEntities, containmentScore } from "./scoring.js";
const textA = "we use Supabase for database storage";
const textB = "Supabase free tier has 500MB limit";
const entitiesA = extractEntities(textA);
const entitiesB = extractEntities(textB);
const score = containmentScore(entitiesA, entitiesB);
console.log(`SCORE: [${textA}] vs [${textB}] = ${score}`);
