import dotenv from 'dotenv';
import { ChatOpenAI } from '@langchain/openai';

dotenv.config();

const apiKey = process.env.OPENAI_API_KEY;
const modelName = process.env.MODEL_NAME;
const baseURL = process.env.BASE_URL;

const model = new ChatOpenAI({ 
    model: modelName,
    apiKey,
    configuration: {
        baseURL,
    },
});

const response = await model.invoke("介绍下自己");
console.log(response.content);