using UnrealBuildTool;

public class BackroomsTarget : TargetRules
{
	public BackroomsTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.V5;
		ExtraModuleNames.Add("Backrooms");
	}
}
