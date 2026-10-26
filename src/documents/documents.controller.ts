import { Controller, Get } from '@nestjs/common';
import { aiAssessmentSchema } from './schemas/test-schemas.js';
import { Public } from '@nestjs/authentication';

@Controller('documents')
export class DocumentsController {

    @Public()
    @Get()
    async memeMax(){
        const result = aiAssessmentSchema.safeParse(JSON.parse(`
  {
  "title": "Avaliação de Biologia",
  "instructions": "Leia as questões com atenção.",
  "sections": [
    {
      "title": "Parte A: Objetivas",
      "questions": [
        {
          "kind": "multiple_choice",
          "statement": "Qual organela celular produz energia?",
          "points": 2,
          "alternatives": ["Ribossomo", "Mitocôndria", "Lisossomo", "Complexo golgiense"],
          "correctIndex": 1
        }
      ]
    },
    {
      "title": "Parte B: Discursivas",
      "questions": [
        {
          "kind": "open_ended",
          "statement": "Explique a importância da fotossíntese para os ecossistemas.",
          "points": 8,
          "expectedAnswer": "Base da cadeia alimentar, produz oxigênio e fixa carbono."
        }
      ]
    }
  ]
        }`))

        if (!result.success) {
            console.log(JSON.stringify(result.error.issues, null, 2));
        } else {
            console.log('ok', result.data);
        }

        return result.data
    }
}
