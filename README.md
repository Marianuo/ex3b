a theoretical project built to explore how AI-based video analysis can detect potentially violent movements using pose estimation.
It’s not meant for practical deployment the focus is on learning concepts.

What it Does
1.Lets a logged-in user upload a video file through a simple web UI.
2.Runs a Python script with a pose detection model (YOLOv8) to track arm movements.
3.If the speed of movement exceeds a threshold, it raises alerts (shown live in the web interface).
4.The user can download a processed version of the video with detections drawn on it.
5.Includes a Stop button to cancel processing early.
6.Ensures no files are permanently stored — temporary uploads are deleted after use.


IMPORTANT 
Purpose:

This project was made as a learning exercise, not a polished production tool.
The main goals were:

Practice full-stack development (Node.js, Express, sessions, EJS).
Experiment with pose detection, thresholds, and real-time feedback.
