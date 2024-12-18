import openai
from decouple import config

from functions.database import get_recent_messages, store_messages


# Retrieve Enviornment Variables
openai.organization = config("OPEN_AI_ORG")
openai.api_key = config("OPEN_AI_KEY")

# Open AI - Chat GPT
# Convert audio to text
def get_chat_response(message_input):

  messages = get_recent_messages()
  user_message = {"role": "user", "content": "user chat: " + message_input}
  messages.append(user_message)
  print(messages)

  try:
    response = openai.ChatCompletion.create(
      model="gpt-4o",
      messages=messages
    )
    message_text = response["choices"][0]["message"]["content"]
    # store_messages(message_input, message_text)
    return message_text
  except Exception as e:
    return
  
def convert_audio_to_text(audio_file):
  try:
    transcript = openai.Audio.transcribe("whisper-1", audio_file)
    message_text = transcript["text"]
    return message_text
  except Exception as e:
    return e