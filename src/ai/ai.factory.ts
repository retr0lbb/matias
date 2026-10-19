import { ConfigService } from "@nestjs/config";
import { AiProvider } from "./ai-provider.type.js";
import { CheapModel } from "./models/cheap.model.js";
import { ExpensiveModel } from "./models/expensive.model.js";
import { Injectable } from "@nestjs/common";

export enum AIExpense {
    CHEAP = "CHEAP",
    EXPENSIVE = "EXPENSIVE",
    NORMAL = "NORMAL"
}

@Injectable()
export class AiExpensesFactory{
    constructor(private readonly configService: ConfigService){}
    
    create(expense: AIExpense): AiProvider{
        switch(expense){
            case AIExpense.CHEAP:{
                return new CheapModel(this.configService.getOrThrow<string>("CHEAP_PROVIDER_KEY"))
            }
            case AIExpense.EXPENSIVE:{
                return new ExpensiveModel(this.configService.getOrThrow<string>("EXPENSIVE_PROVIDER_KEY"))
            }
            case AIExpense.NORMAL:{
                return new CheapModel(this.configService.getOrThrow<string>("GEMINI_API_KEY"))
            }
            default:{
                throw new Error("Model not found (FROM ME)")
            }
        }       
    }
}