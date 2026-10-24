extends Node2D

const Util = preload("res://scripts/util.gd")

# TODO: add jump
func _process(delta):
	position.x += Util.speed() * delta
