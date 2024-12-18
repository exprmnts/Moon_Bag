# uvicorn main:app
# uvicorn main:app --reload

# Main imports
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from decouple import config
import openai
from pydantic import BaseModel

class Message(BaseModel):
    message: str



# Custom function imports
from functions.openai_requests import get_chat_response, convert_audio_to_text
from functions.database import store_messages, reset_messages
from functions.text_to_speech import convert_text_to_speech


# Get Environment Vars
openai.organization = config("OPEN_AI_ORG")
openai.api_key = config("OPEN_AI_KEY")


# Initiate App
app = FastAPI()


# CORS - Origins

origins = ["*"]


# CORS - Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Check health
@app.get("/health")
async def check_health():
    return {"response": "healthy"}


# Reset Conversation
@app.get("/reset")
async def reset_conversation():
    reset_messages()
    return {"response": "conversation reset"}

@app.post("/chat/")
async def chat(message: Message):
    response = get_chat_response(message.message)
    return {"response": response}

# @app.post("/audioToText/")
# async def audioToText(file: UploadFile = File(...)):

#     with open(file.filename, "wb") as buffer:
#         buffer.write(file.file.read())
#     audio_input = open(file.filename, "rb")

#     # Decode audio
#     message_decoded = convert_audio_to_text(audio_input)

#     # Guard: Ensure output
#     if not message_decoded:
#         raise HTTPException(status_code=400, detail="Failed to decode audio")

#     return message_decoded

# @app.post("/textToAudio/")
# async def textToAudio(message: Message):
#     audio_output = convert_text_to_speech(message.message)

#     # Guard: Ensure output
#     if not audio_output:
#         raise HTTPException(status_code=400, detail="Failed audio output")

#     # Create a generator that yields chunks of data
#     def iterfile():
#         yield audio_output

#     # Use for Post: Return output audio
#     return StreamingResponse(iterfile(), media_type="application/octet-stream")