import data from '../../knowledge/inbound_lead.rubric.json'; import type { CriterionId } from '../domain';
export const RUBRIC = data as {id:string; segment:string; criteria:Array<{id:CriterionId;name:string;weight:number;anchors:string[]}>};
export const groups = [['Opening',['opening_rapport','lead_context']],['Discovery',['discovery','listening_control']],['Pitch',['solution_fit','objection_handling']],['Close',['closing_next_step','compliance']]] as const;
