########################################
# core/singleton.py
########################################
import socket, sys
import tkinter.messagebox as msg

def check_single_instance(port=56789):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(('127.0.0.1', port))
        return s
    except socket.error:
        msg.showwarning("提示", "GoldPriceBubble 已在运行中。")
        sys.exit()