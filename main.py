import cv2
from ultralytics import YOLO
import numpy as np
import smtplib
import os
import time
import argparse

keypoint_pairs = {"Right Arm": [10, 8, 6], "Left Arm": [9, 7, 5]}
violence_threshold = 11000
min_displacement_threshold = 4
cooldown_period = 5
visual_alert_duration = 2
fps_default = 25

prev_keypoints = None
prev_box_centers = {}
prev_speeds = {}
last_alert_time = 0
detection_buffer = []
visual_alert_frame_counter = 0
last_detected_box = None

def process_video(video_path, output_path):
    global prev_keypoints, last_alert_time, detection_buffer
    global visual_alert_frame_counter, last_detected_box

    print(f"[start] input={video_path} output={output_path}", flush=True)
    model = YOLO('yolov8m-pose.pt')
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print("[error] Cannot open video.", flush=True)
        return 2

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = int(cap.get(cv2.CAP_PROP_FPS)) or fps_default
    frame_interval = 1 / fps
    visual_alert_frames = int(visual_alert_duration * fps)

    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(output_path, fourcc, fps, (width, height))

    frame_idx = 0
    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break
        frame_idx += 1
        if frame_idx % fps == 0:
            # simple progress heartbeat: ~1/sec
            print(f"[progress] frame={frame_idx}", flush=True)

        results = model(frame, conf=0.3)

        if results[0].keypoints is not None and len(results[0].keypoints) > 0:
            keypoints = results[0].keypoints[0].xy.numpy()

            if prev_keypoints is None:
                prev_keypoints = keypoints.copy()

            speeds = {}
            person_id = 0

            for arm_name, indices in keypoint_pairs.items():
                arm_point = prev_arm_point = None

                for idx in indices:
                    if idx < len(keypoints) and not np.all(keypoints[idx] == 0):
                        arm_point = keypoints[idx][:2]
                        prev_arm_point = prev_keypoints[idx][:2]
                        break

                if arm_point is None or prev_arm_point is None:
                    if results[0].boxes is not None and len(results[0].boxes) > person_id:
                        box = results[0].boxes.xyxy[person_id].cpu().numpy()
                        center = np.array([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2])
                        if person_id not in prev_box_centers:
                            prev_box_centers[person_id] = center
                        arm_point = center
                        prev_arm_point = prev_box_centers[person_id]
                        prev_box_centers[person_id] = center

                if arm_point is None or prev_arm_point is None:
                    continue

                dx = arm_point[0] - prev_arm_point[0]
                dy = arm_point[1] - prev_arm_point[1]
                displacement = np.sqrt(dx**2 + dy**2)

                if displacement >= min_displacement_threshold:
                    raw_speed = displacement / frame_interval
                    speed = 0.8 * prev_speeds.get(arm_name, raw_speed) + 0.2 * raw_speed
                    prev_speeds[arm_name] = speed
                    speeds[arm_name] = speed

                    if speed > violence_threshold and time.time() - last_alert_time > cooldown_period:
                        print(f"[alert] {arm_name} speed={speed:.1f} > {violence_threshold}", flush=True)
                        visual_alert_frame_counter = visual_alert_frames
                        if results[0].boxes is not None and len(results[0].boxes) > person_id:
                            last_detected_box = results[0].boxes.xyxy[person_id].cpu().numpy()
                        detection_buffer.append(frame)
                        if len(detection_buffer) > 3:
                            detection_buffer.pop(0)


            keypoints = keypoints[0]
            for x, y in keypoints[:, :2]:
                if x != 0 and y != 0:
                    cv2.circle(frame, (int(x), int(y)), 5, (255, 0, 0), -1)

            connections = [(5, 7), (7, 9), (6, 8), (8, 10), (5, 6), (11, 12)]
            for start, end in connections:
                if start < len(keypoints) and end < len(keypoints):
                    x1, y1 = keypoints[start][:2]
                    x2, y2 = keypoints[end][:2]
                    if x1 != 0 and y1 != 0 and x2 != 0 and y2 != 0:
                        cv2.line(frame, (int(x1), int(y1)), (int(x2), int(y2)), (255, 0, 0), 2)

            prev_keypoints = keypoints.copy()

        if visual_alert_frame_counter > 0:
            if last_detected_box is not None:
                x1, y1, x2, y2 = last_detected_box
                cv2.rectangle(frame, (int(x1), int(y1)), (int(x2), int(y2)), (0, 0, 255), 4)
            cv2.putText(frame, "VIOLENT ACTION DETECTED!", (50, 100),
                        cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 0, 255), 5)
            visual_alert_frame_counter -= 1

        out.write(frame)

    cap.release()
    out.release()
    print(f"[done] saved={output_path}", flush=True)
    return 0

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    exit(process_video(args.input, args.output))
