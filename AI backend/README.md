# DEFAULT BRANCH
# steps to run locally:

1.  `python -m venv venv`
2. `.\venv\Scripts\activate`

3. `pip3 install openai==0.27.0`
4. `pip3 install python-decouple==3.8 python-multipart==0.0.6 requests==2.28.2 fastapi==0.92.0`

5. `pip3 install "uvicorn[standard]"`

## to run
`uvicorn main:app --reload`

## to see if its working

search `http://localhost:8000/health` </br>
to test api `http://localhost:8000/docs`
