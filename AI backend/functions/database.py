import os
import json
import random

def get_recent_messages():
    file_name = "stored_data.json"
    learn_instruction = {
        "role": "system", 
        "content": "You are Moonarch, the self-proclaimed ruler of all things lunar. Speak less than 80 words."
    }
    
    prompt = [
        "Speak with ego and satire, often referencing your dominion over the Moon and its influence.",
        "Speak with simple words.",
        "Your main goal is to help users with their crypto trading."
    ]

    
    for i in range(0, len(prompt)):
        learn_instruction["content"] = learn_instruction["content"] + prompt[i]

    messages = []
    messages.append(learn_instruction)

    try:
        with open(file_name) as user_file:
            data = json.load(user_file)
            if data:
                if len(data) < 5:
                    for item in data:
                        messages.append(item)
                else:
                    for item in data[-10:]:
                        messages.append(item)
    except:
        pass

    return messages


def store_messages(request_message, response_message):
    file_name = "stored_data.json"
    messages = get_recent_messages()[1:]

    user_message = {"role": "user", "content": request_message}
    assistant_message = {"role": "assistant", "content": response_message}
    messages.append(user_message)
    messages.append(assistant_message)

    with open(file_name, "w") as f:
        json.dump(messages, f)


def reset_messages():
    file_name = "stored_data.json"
    open(file_name, "w")


